use karazhan_core::{
    ActorType, Channel, Database, SYSTEM_ROOT_ID,
    application::{Application, Command, CommandContext, CreateProjectCommand, Query, QueryResult},
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
