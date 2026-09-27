use std::{
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use karazhan_core::{
    ActorType, Channel, CommandMetadata, Database, NewProject, NewResourceBinding,
    ResourceAvailability, ResourceKind, SYSTEM_ROOT_ID,
    application::{Application, Query},
};
use karazhan_tauri_adapter::{TauriAdapter, WorkspaceLauncher};

const PROJECT_ID: &str = "10000000-0000-0000-0000-000000000020";

#[derive(Default)]
struct RecordingLauncher {
    paths: Mutex<Vec<PathBuf>>,
    fail: bool,
}

impl WorkspaceLauncher for RecordingLauncher {
    fn open_in_zed(&self, path: &Path) -> io::Result<()> {
        if self.fail {
            return Err(io::Error::new(io::ErrorKind::NotFound, "Zed missing"));
        }
        self.paths
            .lock()
            .expect("recording launcher")
            .push(path.into());
        Ok(())
    }
}

fn metadata(idempotency_key: &'static str) -> CommandMetadata<'static> {
    CommandMetadata {
        idempotency_key,
        actor_type: ActorType::User,
        actor_ref: Some("user:test"),
        channel: Channel::Ui,
    }
}

fn database_with_workspace(locator: Option<&str>) -> Database {
    let mut database = Database::open_in_memory().expect("in-memory database");
    database
        .create_project(
            NewProject {
                id: PROJECT_ID,
                parent_id: SYSTEM_ROOT_ID,
                key: "zed-project",
                title: "Zed Project",
                position: 0,
                slug: None,
                context_path: None,
            },
            metadata("zed:create-project"),
        )
        .expect("create project");
    if let Some(locator) = locator {
        database
            .add_resource_binding(
                NewResourceBinding {
                    id: "50000000-0000-0000-0000-000000000020",
                    node_id: PROJECT_ID,
                    kind: ResourceKind::Workspace,
                    locator,
                    is_primary: true,
                    availability: ResourceAvailability::Available,
                    source: "user",
                },
                metadata("zed:add-workspace"),
            )
            .expect("add Workspace binding");
    }
    database
}

fn mark_workspace_missing(database: &mut Database) {
    database
        .update_resource_availability(
            "50000000-0000-0000-0000-000000000020",
            ResourceAvailability::Missing,
            1,
            metadata("zed:mark-workspace-missing"),
        )
        .expect("mark Workspace missing");
}

#[test]
fn node_id_resolves_a_canonical_trusted_workspace_before_launch() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let workspace = trusted_root.join("project");
    std::fs::create_dir_all(&workspace).expect("workspace directory");
    let launcher = Arc::new(RecordingLauncher::default());
    let adapter = TauriAdapter::new(Application::new(database_with_workspace(Some(
        workspace.to_str().expect("UTF-8 fixture path"),
    ))))
    .with_zed(vec![trusted_root], launcher.clone())
    .expect("configure trusted root");

    adapter
        .open_in_zed(PROJECT_ID)
        .expect("open trusted Workspace");

    assert_eq!(
        launcher.paths.lock().expect("recorded paths").as_slice(),
        [workspace.canonicalize().expect("canonical workspace")]
    );
}

#[test]
fn missing_workspace_and_launch_services_failure_are_structured() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let workspace = trusted_root.join("project");
    std::fs::create_dir_all(&workspace).expect("workspace directory");

    let missing = TauriAdapter::new(Application::new(database_with_workspace(None)))
        .with_zed(
            vec![trusted_root.clone()],
            Arc::new(RecordingLauncher::default()),
        )
        .expect("configure trusted root")
        .open_in_zed(PROJECT_ID)
        .expect_err("missing binding must fail");
    assert_eq!(missing.code, "workspace_missing");

    let launcher = Arc::new(RecordingLauncher {
        paths: Mutex::default(),
        fail: true,
    });
    let launch_failure = TauriAdapter::new(Application::new(database_with_workspace(Some(
        workspace.to_str().expect("UTF-8 fixture path"),
    ))))
    .with_zed(vec![trusted_root], launcher)
    .expect("configure trusted root")
    .open_in_zed(PROJECT_ID)
    .expect_err("Launch Services failure must be returned");
    assert_eq!(launch_failure.code, "zed_launch_failed");
}

#[test]
fn unavailable_primary_workspace_is_not_opened() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let workspace = trusted_root.join("project");
    std::fs::create_dir_all(&workspace).expect("workspace directory");
    let mut database =
        database_with_workspace(Some(workspace.to_str().expect("UTF-8 fixture path")));
    mark_workspace_missing(&mut database);
    let launcher = Arc::new(RecordingLauncher::default());
    let error = TauriAdapter::new(Application::new(database))
        .with_zed(vec![trusted_root], launcher.clone())
        .expect("configure trusted root")
        .open_in_zed(PROJECT_ID)
        .expect_err("missing Workspace availability must fail");

    assert_eq!(error.code, "workspace_missing");
    assert!(launcher.paths.lock().expect("recorded paths").is_empty());
}

#[test]
fn missing_outside_and_non_directory_workspace_paths_are_rejected() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let outside = directory.path().join("outside");
    std::fs::create_dir_all(&trusted_root).expect("trusted root");
    std::fs::create_dir_all(&outside).expect("outside directory");
    let file = trusted_root.join("not-a-directory");
    std::fs::write(&file, "fixture").expect("fixture file");
    let missing = trusted_root.join("missing");

    for (locator, expected_code) in [
        (missing, "workspace_path_missing"),
        (outside, "untrusted_workspace"),
        (file, "workspace_not_directory"),
    ] {
        let launcher = Arc::new(RecordingLauncher::default());
        let adapter = TauriAdapter::new(Application::new(database_with_workspace(Some(
            locator.to_str().expect("UTF-8 fixture path"),
        ))))
        .with_zed(vec![trusted_root.clone()], launcher.clone())
        .expect("configure trusted root");

        let error = adapter
            .open_in_zed(PROJECT_ID)
            .expect_err("unsafe Workspace must fail");
        assert_eq!(error.code, expected_code);
        assert!(launcher.paths.lock().expect("recorded paths").is_empty());
    }
}

#[cfg(unix)]
#[test]
fn symlink_escape_is_rejected_after_canonicalization() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let outside = directory.path().join("outside");
    let escape = trusted_root.join("escape");
    std::fs::create_dir_all(&trusted_root).expect("trusted root");
    std::fs::create_dir_all(&outside).expect("outside directory");
    symlink(&outside, &escape).expect("escape symlink");
    let launcher = Arc::new(RecordingLauncher::default());
    let adapter = TauriAdapter::new(Application::new(database_with_workspace(Some(
        escape.to_str().expect("UTF-8 fixture path"),
    ))))
    .with_zed(vec![trusted_root], launcher.clone())
    .expect("configure trusted root");

    let error = adapter
        .open_in_zed(PROJECT_ID)
        .expect_err("symlink escape must fail");
    assert_eq!(error.code, "untrusted_workspace");
    assert!(launcher.paths.lock().expect("recorded paths").is_empty());
}

#[test]
fn injected_node_id_never_becomes_a_path_or_process_argument() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let workspace = trusted_root.join("project");
    std::fs::create_dir_all(&workspace).expect("workspace directory");
    let launcher = Arc::new(RecordingLauncher::default());
    let adapter = TauriAdapter::new(Application::new(database_with_workspace(Some(
        workspace.to_str().expect("UTF-8 fixture path"),
    ))))
    .with_zed(vec![trusted_root], launcher.clone())
    .expect("configure trusted root");

    let error = adapter
        .open_in_zed("'; /usr/bin/touch /tmp/karazhan-injected; #")
        .expect_err("forged node ID must fail lookup");
    assert_eq!(error.code, "workspace_missing");
    assert!(launcher.paths.lock().expect("recorded paths").is_empty());
}

#[test]
fn opening_zed_does_not_mutate_business_state() {
    let directory = tempfile::tempdir().expect("temporary root");
    let trusted_root = directory.path().join("trusted");
    let workspace = trusted_root.join("project");
    std::fs::create_dir_all(&workspace).expect("workspace directory");
    let adapter = TauriAdapter::new(Application::new(database_with_workspace(Some(
        workspace.to_str().expect("UTF-8 fixture path"),
    ))))
    .with_zed(vec![trusted_root], Arc::new(RecordingLauncher::default()))
    .expect("configure trusted root");
    let queries = [
        Query::GetProject {
            id: PROJECT_ID.into(),
        },
        Query::ListToday,
        Query::ProgressTimeline {
            node_id: PROJECT_ID.into(),
        },
        Query::ListResourceBindings {
            node_id: PROJECT_ID.into(),
        },
    ];
    let before = queries
        .iter()
        .cloned()
        .map(|query| adapter.query(query).expect("state before open"))
        .collect::<Vec<_>>();

    adapter
        .open_in_zed(PROJECT_ID)
        .expect("open trusted Workspace");

    let after = queries
        .into_iter()
        .map(|query| adapter.query(query).expect("state after open"))
        .collect::<Vec<_>>();
    assert_eq!(after, before);
}
