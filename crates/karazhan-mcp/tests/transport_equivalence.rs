use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    process::{Command as ProcessCommand, Stdio},
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use karazhan_core::{
    ActorType, Channel, Database, SYSTEM_ROOT_ID,
    application::{Application, Command, CommandContext, CreateProjectCommand},
};
use karazhan_http_adapter::HttpAdapter;
use karazhan_tauri_adapter::TauriAdapter;
use serde_json::{Value, json};
use tower::ServiceExt;

const API_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 47_831);

fn create_project(title: &str) -> Command {
    Command::CreateProject(CreateProjectCommand {
        id: "20000000-0000-0000-0000-000000000001".into(),
        parent_id: SYSTEM_ROOT_ID.into(),
        key: "transport-equivalence".into(),
        title: title.into(),
        summary: None,
        position: 0,
        slug: None,
        context_path: None,
        context: CommandContext {
            idempotency_key: "transport:create-project".into(),
            actor_type: ActorType::WorkAssistant,
            actor_ref: Some("assistant:equivalence-test".into()),
            channel: Channel::Api,
        },
    })
}

fn run_tauri() -> (Value, String, String) {
    let adapter = TauriAdapter::new(Application::new(
        Database::open_in_memory().expect("Tauri test database"),
    ));
    let success = serde_json::to_value(
        adapter
            .execute(create_project("Equivalent project"))
            .expect("Tauri success"),
    )
    .expect("serialize Tauri result");
    let error = adapter
        .execute(create_project("Changed payload"))
        .expect_err("Tauri idempotency conflict");
    (success, error.code.into(), error.message)
}

async fn run_http() -> (Value, String, String) {
    let adapter = HttpAdapter::new(
        Application::new(Database::open_in_memory().expect("HTTP test database")),
        API_ADDRESS,
    )
    .expect("HTTP adapter");
    let token = adapter.token().to_owned();
    let router = adapter.router();

    let request = |command: Command| {
        Request::post("/v1/command")
            .header("content-type", "application/json")
            .header("host", "127.0.0.1:47831")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(
                serde_json::to_vec(&command).expect("serialize HTTP command"),
            ))
            .expect("HTTP request")
    };

    let response = router
        .clone()
        .oneshot(request(create_project("Equivalent project")))
        .await
        .expect("HTTP success response");
    assert_eq!(response.status(), StatusCode::OK);
    let success = serde_json::from_slice::<Value>(
        &to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("HTTP success body"),
    )
    .expect("HTTP success JSON");

    let response = router
        .oneshot(request(create_project("Changed payload")))
        .await
        .expect("HTTP error response");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error = serde_json::from_slice::<Value>(
        &to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("HTTP error body"),
    )
    .expect("HTTP error JSON");
    (
        success,
        error["code"].as_str().expect("HTTP error code").into(),
        error["message"]
            .as_str()
            .expect("HTTP error message")
            .into(),
    )
}

fn run_mcp() -> (Value, String, String) {
    let directory = tempfile::tempdir().expect("MCP data directory");
    let mut child = ProcessCommand::new(env!("CARGO_BIN_EXE_karazhan-mcp"))
        .env(
            "KARAZHAN_DATABASE_PATH",
            directory.path().join("karazhan.sqlite3"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start MCP companion");
    let mut stdin = child.stdin.take().expect("MCP stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("MCP stdout"));

    write_frame(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "equivalence-test", "version": "0.1.0" }
            }
        }),
    );
    assert_eq!(read_frame(&mut stdout)["id"], 1);
    write_frame(
        &mut stdin,
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    );
    write_frame(
        &mut stdin,
        &tool_call(2, create_project("Equivalent project")),
    );
    let success_frame = read_frame(&mut stdout);
    write_frame(&mut stdin, &tool_call(3, create_project("Changed payload")));
    let error_frame = read_frame(&mut stdout);
    drop(stdin);

    let status = child.wait().expect("wait for MCP companion");
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("MCP stderr")
        .read_to_string(&mut stderr)
        .expect("read MCP stderr");
    assert!(status.success(), "MCP stderr: {stderr}",);
    assert!(stderr.is_empty(), "unexpected MCP stderr: {stderr}");
    assert_eq!(success_frame["id"], 2);
    let success_text = success_frame["result"]["content"][0]["text"]
        .as_str()
        .expect("MCP success text");
    assert_eq!(error_frame["id"], 3);
    (
        serde_json::from_str(success_text).expect("MCP shared result JSON"),
        error_frame["error"]["data"]["code"]
            .as_str()
            .expect("MCP domain error code")
            .into(),
        error_frame["error"]["message"]
            .as_str()
            .expect("MCP domain error message")
            .into(),
    )
}

fn write_frame(stdin: &mut impl Write, frame: &Value) {
    writeln!(stdin, "{frame}").expect("write MCP frame");
    stdin.flush().expect("flush MCP frame");
}

fn read_frame(stdout: &mut impl BufRead) -> Value {
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read MCP frame");
    assert!(!line.is_empty(), "MCP stdout ended before a response");
    serde_json::from_str(&line).expect("MCP JSON frame")
}

fn tool_call(id: i64, command: Command) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {
            "name": "karazhan_command",
            "arguments": {
                "request": serde_json::to_value(command).expect("serialize MCP command")
            }
        }
    })
}

#[tokio::test]
async fn tauri_http_and_mcp_have_equivalent_success_and_domain_error_semantics() {
    let tauri = run_tauri();
    let http = run_http().await;
    let mcp = run_mcp();

    assert_eq!(tauri.0, http.0);
    assert_eq!(tauri.0, mcp.0);
    assert_eq!(tauri.1, "idempotency_conflict");
    assert_eq!(tauri.1, http.1);
    assert_eq!(tauri.1, mcp.1);
    assert_eq!(tauri.2, http.2);
    assert_eq!(tauri.2, mcp.2);
}
