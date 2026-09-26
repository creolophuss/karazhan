use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command as ProcessCommand, Stdio},
};

use karazhan_core::{
    ActorType, Channel, ProgressEventKind, ResourceAvailability, ResourceKind, SYSTEM_ROOT_ID,
    application::{
        AddResourceBindingCommand, AddTodayCommand, AppendProgressCommand, Command, CommandContext,
        CreateProjectCommand, CreateTaskCommand, Query, RemoveTodayCommand, ReorderTodayCommand,
        UpdateResourceAvailabilityCommand,
    },
};
use serde_json::{Value, json};

const PROJECT_ID: &str = "10000000-0000-0000-0000-000000000010";
const PARENT_TASK_ID: &str = "20000000-0000-0000-0000-000000000010";
const CHILD_TASK_ID: &str = "20000000-0000-0000-0000-000000000011";

struct McpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl McpClient {
    fn start(database_path: &std::path::Path) -> Self {
        let mut child = ProcessCommand::new(env!("CARGO_BIN_EXE_karazhan-mcp"))
            .env("KARAZHAN_DATABASE_PATH", database_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start MCP companion");
        let stdin = child.stdin.take().expect("MCP stdin");
        let stdout = BufReader::new(child.stdout.take().expect("MCP stdout"));
        let mut client = Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        };
        let initialized = client.exchange(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "custodian-test", "version": "0.1.0" }
            }
        }));
        assert_eq!(initialized["id"], 1);
        client.write(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }));
        client.next_id = 2;
        client
    }

    fn command(&mut self, command: Command) -> Value {
        self.call_tool(
            "karazhan_command",
            serde_json::to_value(command).expect("serialize command"),
        )
    }

    fn query(&mut self, query: Query) -> Value {
        self.call_tool(
            "karazhan_query",
            serde_json::to_value(query).expect("serialize query"),
        )
    }

    fn call_tool(&mut self, name: &str, request: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let response = self.exchange(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": { "request": request }
            }
        }));
        assert_eq!(response["id"], id);
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("tool result text");
        serde_json::from_str(text).expect("shared contract result")
    }

    fn exchange(&mut self, frame: Value) -> Value {
        self.write(frame);
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read MCP response");
        assert!(!line.is_empty(), "MCP stdout ended before a response");
        serde_json::from_str(&line).expect("MCP response JSON")
    }

    fn write(&mut self, frame: Value) {
        writeln!(self.stdin, "{frame}").expect("write MCP request");
        self.stdin.flush().expect("flush MCP request");
    }

    fn finish(mut self) {
        drop(self.stdin);
        let status = self.child.wait().expect("wait for MCP companion");
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .expect("MCP stderr")
            .read_to_string(&mut stderr)
            .expect("read MCP stderr");
        assert!(status.success(), "MCP stderr: {stderr}");
        assert!(stderr.is_empty(), "unexpected MCP stderr: {stderr}");
    }
}

fn context(idempotency_key: &str) -> CommandContext {
    CommandContext {
        idempotency_key: idempotency_key.into(),
        actor_type: ActorType::Custodian,
        actor_ref: Some("custodian:workflow-test".into()),
        channel: Channel::Mcp,
    }
}

#[test]
fn custodian_can_drive_the_required_workflow_through_formal_mcp() {
    let directory = tempfile::tempdir().expect("temporary product data");
    let mut client = McpClient::start(&directory.path().join("karazhan.sqlite3"));

    client.command(Command::CreateProject(CreateProjectCommand {
        id: PROJECT_ID.into(),
        parent_id: SYSTEM_ROOT_ID.into(),
        key: "workflow-project".into(),
        title: "Workflow Project".into(),
        summary: None,
        position: 0,
        slug: None,
        context_path: None,
        context: context("workflow:create-project"),
    }));
    client.command(Command::CreateTask(CreateTaskCommand {
        id: PARENT_TASK_ID.into(),
        parent_id: PROJECT_ID.into(),
        key: "parent-task".into(),
        title: "Parent Task".into(),
        summary: None,
        position: 0,
        context: context("workflow:create-parent-task"),
    }));
    client.command(Command::CreateTask(CreateTaskCommand {
        id: CHILD_TASK_ID.into(),
        parent_id: PARENT_TASK_ID.into(),
        key: "child-task".into(),
        title: "Child Task".into(),
        summary: None,
        position: 0,
        context: context("workflow:create-child-task"),
    }));
    let binding_id = "50000000-0000-0000-0000-000000000010";
    client.command(Command::AddResourceBinding(AddResourceBindingCommand {
        id: binding_id.into(),
        node_id: CHILD_TASK_ID.into(),
        kind: ResourceKind::Workspace,
        locator: "/isolated/workflow/child-task".into(),
        is_primary: true,
        availability: ResourceAvailability::Available,
        source: "custodian_manifest".into(),
        context: context("workflow:add-workspace-binding"),
    }));
    client.command(Command::UpdateResourceAvailability(
        UpdateResourceAvailabilityCommand {
            binding_id: binding_id.into(),
            availability: ResourceAvailability::Missing,
            expected_revision: 1,
            context: context("workflow:update-workspace-availability"),
        },
    ));
    client.command(Command::AppendProgress(AppendProgressCommand {
        node_id: CHILD_TASK_ID.into(),
        event_id: "44000000-0000-0000-0000-000000000010".into(),
        event_kind: ProgressEventKind::Progress,
        summary: "Implemented the first workflow slice".into(),
        step_status: None,
        expected_revision: 1,
        context: context("workflow:append-progress"),
    }));

    client.command(Command::AddToday(AddTodayCommand {
        node_id: PARENT_TASK_ID.into(),
        position: 0,
        event_id: "43000000-0000-0000-0000-000000000010".into(),
        context: context("workflow:today-add-parent"),
    }));
    client.command(Command::AddToday(AddTodayCommand {
        node_id: CHILD_TASK_ID.into(),
        position: 1,
        event_id: "43000000-0000-0000-0000-000000000011".into(),
        context: context("workflow:today-add-child"),
    }));
    client.command(Command::ReorderToday(ReorderTodayCommand {
        node_id: CHILD_TASK_ID.into(),
        target_position: 0,
        expected_revision: 1,
        event_id: "43000000-0000-0000-0000-000000000012".into(),
        context: context("workflow:today-reorder-child"),
    }));
    client.command(Command::RemoveToday(RemoveTodayCommand {
        node_id: CHILD_TASK_ID.into(),
        expected_revision: 2,
        event_id: "43000000-0000-0000-0000-000000000013".into(),
        context: context("workflow:today-remove-child"),
    }));

    let projects = client.query(Query::ListProjects);
    assert_eq!(projects["type"], "projects");
    assert_eq!(projects["payload"].as_array().expect("projects").len(), 1);
    assert_eq!(projects["payload"][0]["id"], PROJECT_ID);

    let tasks = client.query(Query::ListTasks);
    assert_eq!(tasks["type"], "tasks");
    assert_eq!(tasks["payload"].as_array().expect("tasks").len(), 2);

    let child = client.query(Query::GetTask {
        id: CHILD_TASK_ID.into(),
    });
    assert_eq!(child["payload"]["parent_id"], PARENT_TASK_ID);
    assert_eq!(child["payload"]["title"], "Child Task");

    let bindings = client.query(Query::ListResourceBindings {
        node_id: CHILD_TASK_ID.into(),
    });
    assert_eq!(bindings["type"], "resource_bindings");
    assert_eq!(bindings["payload"].as_array().expect("bindings").len(), 1);
    assert_eq!(bindings["payload"][0]["id"], binding_id);
    assert_eq!(bindings["payload"][0]["kind"], "workspace");
    assert_eq!(bindings["payload"][0]["availability"], "missing");
    assert_eq!(bindings["payload"][0]["revision"], 2);

    let today = client.query(Query::ListToday);
    let today_items = today["payload"].as_array().expect("Today items");
    assert_eq!(today_items.len(), 1);
    assert_eq!(today_items[0]["node_id"], PARENT_TASK_ID);
    assert_eq!(today_items[0]["direct_child_tasks"][0]["id"], CHILD_TASK_ID);

    let timeline = client.query(Query::ProgressTimeline {
        node_id: CHILD_TASK_ID.into(),
    });
    assert!(
        timeline["payload"]
            .as_array()
            .expect("progress timeline")
            .iter()
            .any(|event| event["summary"] == "Implemented the first workflow slice")
    );

    client.finish();
}
