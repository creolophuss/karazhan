use karazhan_core::{
    ActorType, BacklogFilter, BacklogKind, Channel, CommandMetadata, Database, NewNode, NodeKind,
    Priority, SYSTEM_ROOT_ID,
    application::{
        Application, Command, CommandContext, CreateProjectCommand, MoveBacklogCommand, Query,
        QueryResult, UpdateBacklogCommand,
    },
};
use karazhan_tauri_adapter::{AdapterError, TauriAdapter};

fn context(idempotency_key: &str) -> CommandContext {
    CommandContext {
        idempotency_key: idempotency_key.into(),
        actor_type: ActorType::WorkAssistant,
        actor_ref: Some("assistant:test".into()),
        channel: Channel::Ui,
    }
}

fn create_project(title: &str, idempotency_key: &str) -> Command {
    Command::CreateProject(CreateProjectCommand {
        id: "10000000-0000-0000-0000-000000000001".into(),
        parent_id: SYSTEM_ROOT_ID.into(),
        key: "ipc".into(),
        title: title.into(),
        summary: None,
        position: 0,
        slug: None,
        context_path: None,
        context: context(idempotency_key),
    })
}

#[test]
fn tauri_adapter_delegates_commands_queries_and_structured_errors_to_shared_core() {
    let application = Application::new(Database::open_in_memory().expect("in-memory database"));
    let adapter = TauriAdapter::new(application);

    adapter
        .execute(create_project("IPC Project", "ipc:create"))
        .expect("command should reach shared core");

    let QueryResult::Project(project) = adapter
        .query(Query::GetProject {
            id: "10000000-0000-0000-0000-000000000001".into(),
        })
        .expect("query should reach shared core")
    else {
        panic!("unexpected query result");
    };
    assert_eq!(project.title, "IPC Project");

    let error = adapter
        .execute(create_project("Changed payload", "ipc:create"))
        .expect_err("shared idempotency rule should be preserved");
    assert_eq!(error.code, "idempotency_conflict");
    assert_eq!(
        error.message,
        "idempotency key was already used with a different request"
    );
    assert_eq!(
        serde_json::to_value(&error).expect("serialize adapter error"),
        serde_json::json!({
            "code": "idempotency_conflict",
            "message": error.message,
        })
    );
}

#[test]
fn adapter_error_is_the_transport_shape_of_a_domain_error() {
    let error = AdapterError::from(karazhan_core::DomainError::NotFound);

    assert_eq!(error.code, "not_found");
    assert_eq!(error.message, "requested object was not found");
}

#[test]
fn tauri_adapter_uses_the_shared_backlog_contract_without_adapter_rules() {
    let project_id = "10000000-0000-0000-0000-000000000001";
    let second_project_id = "10000000-0000-0000-0000-000000000002";
    let backlog_id = "30000000-0000-0000-0000-000000000001";
    let mut database = Database::open_in_memory().expect("in-memory database");
    for (id, kind, parent_id, key, position) in [
        (project_id, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
        (
            second_project_id,
            NodeKind::Project,
            SYSTEM_ROOT_ID,
            "second",
            1,
        ),
        (backlog_id, NodeKind::Backlog, project_id, "idea", 0),
    ] {
        database
            .create_node(
                NewNode {
                    id,
                    kind,
                    parent_id,
                    key,
                    title: key,
                    position,
                },
                CommandMetadata {
                    idempotency_key: id,
                    actor_type: ActorType::System,
                    actor_ref: Some("adapter-fixture"),
                    channel: Channel::Ui,
                },
            )
            .expect("fixture node");
    }
    let adapter = TauriAdapter::new(Application::new(database));

    adapter
        .execute(Command::UpdateBacklog(UpdateBacklogCommand {
            node_id: backlog_id.into(),
            title: Some("Edited through IPC".into()),
            notes: None,
            kind: Some(BacklogKind::Research),
            priority: Some(Priority::High),
            tags: Some(vec!["ipc".into()]),
            expected_revision: 1,
            context: context("ipc:update-backlog"),
        }))
        .expect("Backlog command should reach shared core");

    let QueryResult::Backlog(items) = adapter
        .query(Query::ListBacklog {
            filter: BacklogFilter::default(),
        })
        .expect("Backlog query should reach shared core")
    else {
        panic!("unexpected query result");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "Edited through IPC");
    assert_eq!(items[0].tags, vec!["ipc"]);

    adapter
        .execute(Command::MoveBacklog(MoveBacklogCommand {
            node_id: backlog_id.into(),
            parent_id: second_project_id.into(),
            target_position: None,
            expected_revision: 2,
            context: context("ipc:move-backlog"),
        }))
        .expect("Backlog move should reach shared core");
    let QueryResult::Backlog(items) = adapter
        .query(Query::ListBacklog {
            filter: BacklogFilter {
                parent_id: Some(second_project_id.into()),
                ..BacklogFilter::default()
            },
        })
        .expect("moved Backlog should remain queryable")
    else {
        panic!("unexpected query result");
    };
    assert_eq!(items[0].id, backlog_id);

    let conflict = adapter
        .execute(Command::UpdateBacklog(UpdateBacklogCommand {
            node_id: backlog_id.into(),
            title: Some("Stale".into()),
            notes: None,
            kind: None,
            priority: None,
            tags: None,
            expected_revision: 1,
            context: context("ipc:stale-backlog"),
        }))
        .expect_err("shared revision conflict should cross adapter");
    assert_eq!(conflict.code, "revision_conflict");
}
