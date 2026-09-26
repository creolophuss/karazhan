use super::*;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use tempfile::tempdir;

const PROJECT_ID: &str = "10000000-0000-0000-0000-000000000001";
const TASK_ID: &str = "20000000-0000-0000-0000-000000000001";
const CHILD_TASK_ID: &str = "20000000-0000-0000-0000-000000000002";
const BACKLOG_ID: &str = "30000000-0000-0000-0000-000000000001";
const EVENT_ID: &str = "40000000-0000-0000-0000-000000000001";

fn node<'a>(
    id: &'a str,
    kind: NodeKind,
    parent_id: &'a str,
    key: &'a str,
    position: i64,
) -> NewNode<'a> {
    NewNode {
        id,
        kind,
        parent_id,
        key,
        title: key,
        position,
    }
}

fn metadata(key: &str) -> CommandMetadata<'_> {
    CommandMetadata {
        idempotency_key: key,
        actor_type: ActorType::Custodian,
        actor_ref: Some("custodian"),
        channel: Channel::Mcp,
    }
}

#[test]
fn custodian_preserves_the_existing_task_agent_wire_value() {
    assert_eq!(
        serde_json::to_value(ActorType::Custodian).unwrap(),
        serde_json::json!("task_agent")
    );
    assert_eq!(
        serde_json::from_value::<ActorType>(serde_json::json!("task_agent")).unwrap(),
        ActorType::Custodian
    );
}

fn create(db: &mut Database, value: NewNode<'_>) -> Result<MutationResult, DomainError> {
    let key = format!("create:{}", value.id);
    db.create_node(value, metadata(&key))
}

fn node_location(db: &Database, node_id: &str) -> (String, i64, i64) {
    db.connection
        .query_row(
            "SELECT parent_id, position, revision FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn child_order(db: &Database, parent_id: &str) -> Vec<(String, i64, i64)> {
    let mut statement = db
        .connection
        .prepare(
            "SELECT id, position, revision FROM work_nodes
             WHERE parent_id = ?1 ORDER BY position, id",
        )
        .unwrap();
    statement
        .query_map([parent_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn today_order(db: &Database) -> Vec<(String, i64, i64)> {
    let mut statement = db
        .connection
        .prepare("SELECT node_id, position, revision FROM today_items ORDER BY position, node_id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn work_state(db: &Database, node_id: &str) -> (String, i64, String, String, i64) {
    db.connection
        .query_row(
            "SELECT parent_id, position, work_status, priority, revision
             FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap()
}

#[test]
fn migration_creates_one_immutable_root() {
    let db = Database::open_in_memory().unwrap();

    assert_eq!(db.node_count(NodeKind::Root).unwrap(), 1);

    let second_root = db.connection.execute(
        "INSERT INTO work_nodes (
            id, kind, parent_id, key, title, work_status, priority, position,
            created_at, updated_at, created_actor, updated_actor, write_source, revision
         ) VALUES (?1, 'root', NULL, 'root', 'Other Root', NULL, NULL, 0,
                   '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z',
                   'system', 'system', 'system', 1)",
        ["00000000-0000-0000-0000-000000000002"],
    );
    assert!(
        second_root
            .unwrap_err()
            .to_string()
            .contains("one_system_root")
    );

    let update_root = db.connection.execute(
        "UPDATE work_nodes SET key = 'changed' WHERE id = ?1",
        [SYSTEM_ROOT_ID],
    );
    assert!(
        update_root
            .unwrap_err()
            .to_string()
            .contains("system_root_immutable")
    );

    let delete_root = db
        .connection
        .execute("DELETE FROM work_nodes WHERE id = ?1", [SYSTEM_ROOT_ID]);
    assert!(
        delete_root
            .unwrap_err()
            .to_string()
            .contains("system_root_immutable")
    );
}

#[test]
fn work_tree_enforces_parent_matrix_and_rejects_cycles() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "child", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, TASK_ID, "idea", 1),
    )
    .unwrap();

    let project_under_task = create(
        &mut db,
        node(
            "10000000-0000-0000-0000-000000000002",
            NodeKind::Project,
            TASK_ID,
            "illegal-project",
            2,
        ),
    );
    assert!(matches!(
        project_under_task,
        Err(DomainError::InvalidParentKind)
    ));

    let task_under_backlog = create(
        &mut db,
        node(
            "20000000-0000-0000-0000-000000000003",
            NodeKind::Task,
            BACKLOG_ID,
            "illegal-task",
            0,
        ),
    );
    assert!(matches!(
        task_under_backlog,
        Err(DomainError::InvalidParentKind)
    ));

    let cycle = db.move_node(
        TASK_ID,
        CHILD_TASK_ID,
        2,
        1,
        "42000000-0000-0000-0000-000000000001",
        metadata("move-cycle"),
    );
    assert!(matches!(cycle, Err(DomainError::WorkTreeCycle)));
}

#[test]
fn archive_reopen_and_permanent_delete_are_recursive_and_atomic() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "child", 0),
    )
    .unwrap();

    db.connection
        .execute(
            "INSERT INTO today_items (node_id, position, added_at, added_actor, revision)
             VALUES (?1, 0, '2026-09-24T00:00:00Z', 'user', 1),
                    (?2, 1, '2026-09-24T00:00:00Z', 'user', 1),
                    (?3, 2, '2026-09-24T00:00:00Z', 'user', 1)",
            [PROJECT_ID, TASK_ID, CHILD_TASK_ID],
        )
        .unwrap();

    let active_delete =
        db.permanently_delete_archived_subtree(PROJECT_ID, 1, metadata("delete-active-project"));
    assert!(matches!(active_delete, Err(DomainError::NotArchived)));

    db.archive_subtree(
        TASK_ID,
        1,
        "40000000-0000-0000-0000-000000000099",
        metadata("archive-task"),
    )
    .unwrap();

    let active = db.list_project_task_tree().unwrap();
    assert_eq!(
        active
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![PROJECT_ID]
    );
    let archived = db.list_archived_project_task_tree().unwrap();
    assert_eq!(
        archived
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![TASK_ID, CHILD_TASK_ID]
    );
    let today = db.list_today().unwrap();
    assert_eq!(today.len(), 1);
    assert_eq!(today[0].node_id, PROJECT_ID);
    assert!(today[0].direct_child_tasks.is_empty());
    assert_eq!(db.progress_event_count(TASK_ID).unwrap(), 1);

    let child_of_archived = create(
        &mut db,
        node(
            "20000000-0000-0000-0000-000000000003",
            NodeKind::Task,
            TASK_ID,
            "too-late",
            1,
        ),
    );
    assert!(matches!(child_of_archived, Err(DomainError::ArchivedNode)));
    let archived_today = db.add_to_today(
        TASK_ID,
        1,
        "40000000-0000-0000-0000-000000000098",
        metadata("today-archived-task"),
    );
    assert!(matches!(archived_today, Err(DomainError::ArchivedNode)));

    let reopened = db
        .reopen_archived_subtree(
            TASK_ID,
            2,
            "40000000-0000-0000-0000-000000000097",
            metadata("reopen-task"),
        )
        .unwrap();
    assert_eq!(reopened.revision, 3);
    assert_eq!(db.list_project_task_tree().unwrap().len(), 3);
    assert!(db.list_archived_project_task_tree().unwrap().is_empty());
    assert_eq!(db.list_today().unwrap().len(), 1);
    let replay = db
        .reopen_archived_subtree(
            TASK_ID,
            2,
            "40000000-0000-0000-0000-000000000097",
            metadata("reopen-task"),
        )
        .unwrap();
    assert!(replay.replayed);
    let active_reopen = db.reopen_archived_subtree(
        TASK_ID,
        3,
        "40000000-0000-0000-0000-000000000096",
        metadata("reopen-active-task"),
    );
    assert!(matches!(active_reopen, Err(DomainError::NotArchived)));

    db.archive_subtree(
        TASK_ID,
        3,
        "40000000-0000-0000-0000-000000000095",
        metadata("rearchive-task"),
    )
    .unwrap();
    db.permanently_delete_archived_subtree(TASK_ID, 4, metadata("delete-archived-task"))
        .unwrap();
    assert!(db.list_archived_project_task_tree().unwrap().is_empty());
    assert!(matches!(db.get_task(TASK_ID), Err(DomainError::NotFound)));
    assert!(matches!(
        db.get_task(CHILD_TASK_ID),
        Err(DomainError::NotFound)
    ));
    assert_eq!(db.list_project_task_tree().unwrap().len(), 1);
}

#[test]
fn move_command_is_atomic_idempotent_and_records_parent_change() {
    let mut db = Database::open_in_memory().unwrap();
    let target_project_id = "10000000-0000-0000-0000-000000000002";
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "source", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            target_project_id,
            NodeKind::Project,
            SYSTEM_ROOT_ID,
            "target",
            1,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "child", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            "20000000-0000-0000-0000-000000000003",
            NodeKind::Task,
            target_project_id,
            "task",
            0,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            "20000000-0000-0000-0000-000000000004",
            NodeKind::Task,
            target_project_id,
            "other",
            1,
        ),
    )
    .unwrap();

    let key_conflict = db.move_node(
        TASK_ID,
        target_project_id,
        2,
        1,
        "42000000-0000-0000-0000-000000000002",
        metadata("move-key-conflict"),
    );
    assert!(key_conflict.is_err());
    assert_eq!(node_location(&db, TASK_ID), (PROJECT_ID.into(), 0, 1));

    let position_conflict = db.move_node(
        CHILD_TASK_ID,
        target_project_id,
        1,
        1,
        "42000000-0000-0000-0000-000000000003",
        metadata("move-position-conflict"),
    );
    assert!(position_conflict.is_err());
    assert_eq!(node_location(&db, CHILD_TASK_ID), (TASK_ID.into(), 0, 1));

    let invalid_parent = db.move_node(
        PROJECT_ID,
        "20000000-0000-0000-0000-000000000003",
        2,
        1,
        "42000000-0000-0000-0000-000000000004",
        metadata("move-invalid-parent"),
    );
    assert!(
        matches!(&invalid_parent, Err(DomainError::InvalidParentKind)),
        "unexpected result: {invalid_parent:?}"
    );
    assert_eq!(
        node_location(&db, PROJECT_ID),
        (SYSTEM_ROOT_ID.into(), 0, 1)
    );

    let moved = db
        .move_node(
            CHILD_TASK_ID,
            target_project_id,
            2,
            1,
            "42000000-0000-0000-0000-000000000005",
            metadata("move-child"),
        )
        .unwrap();
    assert_eq!(moved.revision, 2);
    assert!(!moved.replayed);
    assert_eq!(
        node_location(&db, CHILD_TASK_ID),
        (target_project_id.into(), 2, 2)
    );
    let event: (String, String) = db
        .connection
        .query_row(
            "SELECT event_type, evidence_json FROM progress_events WHERE id = ?1",
            ["42000000-0000-0000-0000-000000000005"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(event.0, "parent_changed");
    assert!(event.1.contains(TASK_ID));
    assert!(event.1.contains(target_project_id));

    let replay = db
        .move_node(
            CHILD_TASK_ID,
            target_project_id,
            2,
            1,
            "42000000-0000-0000-0000-000000000005",
            metadata("move-child"),
        )
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.revision, 2);
    assert_eq!(db.progress_event_count(CHILD_TASK_ID).unwrap(), 1);

    let duplicate_event = db.move_node(
        CHILD_TASK_ID,
        TASK_ID,
        0,
        2,
        "42000000-0000-0000-0000-000000000005",
        metadata("move-duplicate-event"),
    );
    assert!(duplicate_event.is_err());
    assert_eq!(
        node_location(&db, CHILD_TASK_ID),
        (target_project_id.into(), 2, 2)
    );
}

#[test]
fn sibling_reorder_is_atomic_and_safe_to_replay() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    for (id, key, position) in [
        (TASK_ID, "first", 0),
        (CHILD_TASK_ID, "second", 1),
        ("20000000-0000-0000-0000-000000000003", "third", 2),
    ] {
        create(&mut db, node(id, NodeKind::Task, PROJECT_ID, key, position)).unwrap();
    }

    let reordered = db
        .reorder_node(TASK_ID, 2, 1, metadata("reorder-first-to-last"))
        .unwrap();
    assert_eq!(reordered.revision, 2);
    assert!(!reordered.replayed);
    assert_eq!(
        child_order(&db, PROJECT_ID),
        vec![
            (CHILD_TASK_ID.into(), 0, 2),
            ("20000000-0000-0000-0000-000000000003".into(), 1, 2),
            (TASK_ID.into(), 2, 2),
        ]
    );

    let replay = db
        .reorder_node(TASK_ID, 2, 1, metadata("reorder-first-to-last"))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.revision, 2);

    let invalid = db.reorder_node(TASK_ID, 3, 2, metadata("reorder-invalid-index"));
    assert!(matches!(invalid, Err(DomainError::InvalidPosition)));
    let before_failure = child_order(&db, PROJECT_ID);

    db.connection
        .execute_batch(
            "CREATE TRIGGER test_reorder_failure
             BEFORE UPDATE OF position ON work_nodes
             WHEN NEW.id = '20000000-0000-0000-0000-000000000003'
               AND NEW.position = 2
             BEGIN
               SELECT RAISE(ABORT, 'injected_reorder_failure');
             END;",
        )
        .unwrap();
    let injected_failure = db.reorder_node(TASK_ID, 0, 2, metadata("reorder-injected-failure"));
    assert!(injected_failure.is_err());
    assert_eq!(child_order(&db, PROJECT_ID), before_failure);
}

#[test]
fn sibling_key_and_position_conflicts_leave_existing_order_intact() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();

    assert!(
        create(
            &mut db,
            node(
                "10000000-0000-0000-0000-000000000002",
                NodeKind::Project,
                SYSTEM_ROOT_ID,
                "project",
                1,
            )
        )
        .is_err()
    );
    assert!(
        create(
            &mut db,
            node(
                "10000000-0000-0000-0000-000000000003",
                NodeKind::Project,
                SYSTEM_ROOT_ID,
                "other",
                0,
            )
        )
        .is_err()
    );
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
}

#[test]
fn today_accepts_projects_and_tasks_but_rejects_backlog() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "idea", 1),
    )
    .unwrap();

    db.add_to_today(
        PROJECT_ID,
        0,
        "43000000-0000-0000-0000-000000000001",
        metadata("today-add-project"),
    )
    .unwrap();
    db.add_to_today(
        TASK_ID,
        1,
        "43000000-0000-0000-0000-000000000002",
        metadata("today-add-task"),
    )
    .unwrap();
    assert!(matches!(
        db.add_to_today(
            BACKLOG_ID,
            2,
            "43000000-0000-0000-0000-000000000003",
            metadata("today-add-backlog")
        ),
        Err(DomainError::InvalidTodayTarget)
    ));
}

#[test]
fn today_mutations_are_atomic_and_do_not_change_work_tree_fields() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    let project_before = work_state(&db, PROJECT_ID);
    let task_before = work_state(&db, TASK_ID);

    db.add_to_today(
        PROJECT_ID,
        0,
        "43000000-0000-0000-0000-000000000010",
        metadata("today-project-add"),
    )
    .unwrap();
    let added = db
        .add_to_today(
            TASK_ID,
            1,
            "43000000-0000-0000-0000-000000000011",
            metadata("today-task-add"),
        )
        .unwrap();
    assert_eq!(added.revision, 1);
    let add_replay = db
        .add_to_today(
            TASK_ID,
            1,
            "43000000-0000-0000-0000-000000000011",
            metadata("today-task-add"),
        )
        .unwrap();
    assert!(add_replay.replayed);

    db.reorder_today_item(
        TASK_ID,
        0,
        1,
        "43000000-0000-0000-0000-000000000012",
        metadata("today-task-first"),
    )
    .unwrap();
    assert_eq!(
        today_order(&db),
        vec![(TASK_ID.into(), 0, 2), (PROJECT_ID.into(), 1, 2)]
    );

    db.remove_from_today(
        TASK_ID,
        2,
        "43000000-0000-0000-0000-000000000013",
        metadata("today-task-remove"),
    )
    .unwrap();
    assert_eq!(today_order(&db), vec![(PROJECT_ID.into(), 1, 2)]);

    let duplicate_event = db.remove_from_today(
        PROJECT_ID,
        2,
        "43000000-0000-0000-0000-000000000013",
        metadata("today-project-remove-duplicate-event"),
    );
    assert!(duplicate_event.is_err());
    assert_eq!(today_order(&db), vec![(PROJECT_ID.into(), 1, 2)]);
    assert_eq!(work_state(&db, PROJECT_ID), project_before);
    assert_eq!(work_state(&db, TASK_ID), task_before);

    let event_types: Vec<String> = {
        let mut statement = db
            .connection
            .prepare("SELECT event_type FROM progress_events ORDER BY recorded_at, id")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert_eq!(
        event_types,
        vec![
            "today_added",
            "today_added",
            "today_reordered",
            "today_removed"
        ]
    );
}

#[test]
fn today_projection_shows_only_direct_non_member_child_tasks() {
    let mut db = Database::open_in_memory().unwrap();
    let second_task_id = "20000000-0000-0000-0000-000000000003";
    let grandchild_id = "20000000-0000-0000-0000-000000000004";
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "first", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(second_task_id, NodeKind::Task, PROJECT_ID, "second", 1),
    )
    .unwrap();
    create(
        &mut db,
        node(
            grandchild_id,
            NodeKind::Task,
            second_task_id,
            "grandchild",
            0,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            "10000000-0000-0000-0000-000000000002",
            NodeKind::Project,
            PROJECT_ID,
            "nested-project",
            2,
        ),
    )
    .unwrap();
    db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            status: Some(WorkStatus::InProgress),
            priority: Some(Priority::High),
            blocker: TextChange::Set("Waiting for review"),
            ..WorkItemPatch::default()
        },
        1,
        "43000000-0000-0000-0000-000000000019",
        metadata("projection-update-project"),
    )
    .unwrap();
    db.update_work_item(
        TASK_ID,
        WorkItemPatch {
            summary: TextChange::Set("Task description"),
            ..WorkItemPatch::default()
        },
        1,
        "43000000-0000-0000-0000-000000000023",
        metadata("projection-update-task-description"),
    )
    .unwrap();
    db.add_resource_binding(
        NewResourceBinding {
            id: "50000000-0000-0000-0000-000000000020",
            node_id: PROJECT_ID,
            kind: ResourceKind::Workspace,
            locator: "/trusted/project-workspace",
            is_primary: true,
            availability: ResourceAvailability::Available,
            source: "test",
        },
        metadata("projection-add-project-workspace"),
    )
    .unwrap();
    db.add_to_today(
        PROJECT_ID,
        0,
        "43000000-0000-0000-0000-000000000020",
        metadata("projection-add-project"),
    )
    .unwrap();
    db.add_to_today(
        TASK_ID,
        1,
        "43000000-0000-0000-0000-000000000021",
        metadata("projection-add-first-task"),
    )
    .unwrap();

    let projected = db.list_today().unwrap();
    assert_eq!(
        projected
            .iter()
            .map(|item| item.node_id.as_str())
            .collect::<Vec<_>>(),
        vec![PROJECT_ID, TASK_ID]
    );
    assert_eq!(projected[0].revision, 1);
    assert_eq!(projected[0].work_revision, 2);
    assert_eq!(projected[0].status, "in_progress");
    assert_eq!(projected[0].priority, "high");
    assert_eq!(projected[0].blocker.as_deref(), Some("Waiting for review"));
    assert_eq!(projected[0].path_titles, vec!["project"]);
    assert_eq!(projected[1].path_titles, vec!["project", "first"]);
    assert_eq!(projected[1].summary.as_deref(), Some("Task description"));
    assert!(projected[0].has_available_workspace);
    assert!(!projected[1].has_available_workspace);
    assert_eq!(
        projected[0]
            .direct_child_tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec![second_task_id]
    );
    assert!(projected[1].direct_child_tasks.is_empty());

    db.remove_from_today(
        TASK_ID,
        1,
        "43000000-0000-0000-0000-000000000022",
        metadata("projection-remove-first-task"),
    )
    .unwrap();
    let projected = db.list_today().unwrap();
    assert_eq!(
        projected[0]
            .direct_child_tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec![TASK_ID, second_task_id]
    );
    assert!(
        projected[0]
            .direct_child_tasks
            .iter()
            .all(|task| task.id != grandchild_id)
    );
}

#[test]
fn project_task_tree_projection_keeps_mixed_hierarchy_and_sibling_positions() {
    let mut db = Database::open_in_memory().unwrap();
    let nested_project_id = "10000000-0000-0000-0000-000000000002";
    let standalone_task_id = "20000000-0000-0000-0000-000000000003";
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            nested_project_id,
            NodeKind::Project,
            PROJECT_ID,
            "nested-project",
            0,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 1),
    )
    .unwrap();
    create(
        &mut db,
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "child", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            standalone_task_id,
            NodeKind::Task,
            SYSTEM_ROOT_ID,
            "standalone",
            1,
        ),
    )
    .unwrap();

    db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            title: Some("Renamed Project"),
            summary: TextChange::Set("Summary"),
            goal: TextChange::Set("Goal"),
            acceptance: TextChange::Set("Acceptance"),
            ..WorkItemPatch::default()
        },
        1,
        "45000000-0000-0000-0000-000000000001",
        metadata("tree-project-fields"),
    )
    .unwrap();

    let projected = db.list_project_task_tree().unwrap();
    assert_eq!(projected.len(), 5);
    assert_eq!(projected[0].id, PROJECT_ID);
    assert_eq!(projected[0].kind, "project");
    assert_eq!(projected[0].parent_id, SYSTEM_ROOT_ID);
    assert_eq!(projected[0].position, 0);
    assert_eq!(projected[0].title, "Renamed Project");
    assert_eq!(projected[0].summary.as_deref(), Some("Summary"));
    assert_eq!(projected[0].goal.as_deref(), Some("Goal"));
    assert_eq!(projected[0].acceptance.as_deref(), Some("Acceptance"));
    assert_eq!(projected[0].revision, 2);
    assert_eq!(projected[1].id, standalone_task_id);
    assert_eq!(projected[1].kind, "task");
    assert_eq!(projected[1].parent_id, SYSTEM_ROOT_ID);
    assert_eq!(projected[1].position, 1);
    assert_eq!(projected[2].id, nested_project_id);
    assert_eq!(projected[2].parent_id, PROJECT_ID);
    assert_eq!(projected[2].position, 0);
    assert_eq!(projected[3].id, TASK_ID);
    assert_eq!(projected[3].parent_id, PROJECT_ID);
    assert_eq!(projected[3].position, 1);
    assert_eq!(projected[4].id, CHILD_TASK_ID);
    assert_eq!(projected[4].parent_id, TASK_ID);
}

#[test]
fn progress_append_and_queries_do_not_change_current_fields() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, SYSTEM_ROOT_ID, "task", 0),
    )
    .unwrap();
    db.update_work_item(
        TASK_ID,
        WorkItemPatch {
            status: Some(WorkStatus::InProgress),
            priority: Some(Priority::High),
            blocker: TextChange::Set("Existing blocker"),
            ..WorkItemPatch::default()
        },
        1,
        "44000000-0000-0000-0000-000000000001",
        metadata("set-current-fields-before-log"),
    )
    .unwrap();
    let before = work_state(&db, TASK_ID);

    db.append_progress_event(
        TASK_ID,
        NewProgressEvent {
            id: "44000000-0000-0000-0000-000000000002",
            kind: ProgressEventKind::Progress,
            summary: "Implemented query",
            step_status: Some(WorkStatus::Pending),
        },
        2,
        metadata("append-progress"),
    )
    .unwrap();
    let delivery = db
        .append_progress_event(
            TASK_ID,
            NewProgressEvent {
                id: "44000000-0000-0000-0000-000000000003",
                kind: ProgressEventKind::Delivery,
                summary: "Ready for review",
                step_status: None,
            },
            2,
            metadata("append-delivery"),
        )
        .unwrap();
    let replay = db
        .append_progress_event(
            TASK_ID,
            NewProgressEvent {
                id: "44000000-0000-0000-0000-000000000003",
                kind: ProgressEventKind::Delivery,
                summary: "Ready for review",
                step_status: None,
            },
            2,
            metadata("append-delivery"),
        )
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.revision, delivery.revision);
    assert_eq!(work_state(&db, TASK_ID), before);

    let recent = db.recent_progress_events(TASK_ID, 1).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].summary, "Ready for review");
    let timeline = db.progress_timeline(TASK_ID).unwrap();
    assert_eq!(timeline.len(), 3);
    assert_eq!(timeline[0].event_type, "progress");
    assert_eq!(timeline[1].summary, "Implemented query");
    assert_eq!(timeline[1].step_status.as_deref(), Some("pending"));
    assert_eq!(timeline[2].event_type, "delivery");
    assert_eq!(timeline[2].step_status, None);
    assert!(
        db.list_project_task_tree()
            .unwrap()
            .iter()
            .find(|item| item.id == TASK_ID)
            .unwrap()
            .has_steps
    );
    assert_eq!(work_state(&db, TASK_ID), before);

    let stale = db.append_progress_event(
        TASK_ID,
        NewProgressEvent {
            id: "44000000-0000-0000-0000-000000000004",
            kind: ProgressEventKind::Progress,
            summary: "Stale progress",
            step_status: Some(WorkStatus::Ready),
        },
        1,
        metadata("append-stale-progress"),
    );
    assert!(matches!(
        stale,
        Err(DomainError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert_eq!(db.progress_timeline(TASK_ID).unwrap().len(), 3);
}

#[test]
fn status_and_progress_event_commit_atomically_with_revision_check() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, SYSTEM_ROOT_ID, "task", 0),
    )
    .unwrap();

    let result = db
        .update_status(
            TASK_ID,
            WorkStatus::InProgress,
            1,
            EVENT_ID,
            metadata("status:task:in-progress"),
        )
        .unwrap();
    assert_eq!(result.revision, 2);
    assert_eq!(db.node_status(TASK_ID).unwrap(), "in_progress");
    assert_eq!(db.progress_event_count(TASK_ID).unwrap(), 1);

    let conflict = db.update_status(
        TASK_ID,
        WorkStatus::Done,
        1,
        "40000000-0000-0000-0000-000000000002",
        metadata("status:task:done"),
    );
    assert!(matches!(
        conflict,
        Err(DomainError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert_eq!(db.node_status(TASK_ID).unwrap(), "in_progress");
    assert_eq!(db.node_revision(TASK_ID).unwrap(), 2);
    assert_eq!(db.progress_event_count(TASK_ID).unwrap(), 1);
}

#[test]
fn database_finishes_with_no_integrity_or_domain_invariant_violations() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();

    let report = db.integrity_report().unwrap();
    assert_eq!(report.integrity, "ok");
    assert_eq!(report.foreign_key_violations, 0);
    assert_eq!(report.invariant_violations, 0);
}

#[test]
fn file_database_preserves_nodes_today_and_events_after_reopen() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("karazhan.db");
    {
        let mut db = Database::open(&path).unwrap();
        create(
            &mut db,
            node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 1),
        )
        .unwrap();
        create(
            &mut db,
            node(TASK_ID, NodeKind::Task, SYSTEM_ROOT_ID, "task", 0),
        )
        .unwrap();
        db.add_to_today(
            PROJECT_ID,
            0,
            "43000000-0000-0000-0000-000000000004",
            metadata("today-add-persistent-project"),
        )
        .unwrap();
        db.add_to_today(
            TASK_ID,
            1,
            "43000000-0000-0000-0000-000000000005",
            metadata("today-add-persistent-task"),
        )
        .unwrap();
        db.reorder_today_item(
            TASK_ID,
            0,
            1,
            "43000000-0000-0000-0000-000000000006",
            metadata("today-reorder-persistent-task"),
        )
        .unwrap();
        db.update_status(
            TASK_ID,
            WorkStatus::Review,
            1,
            EVENT_ID,
            metadata("status:task:review"),
        )
        .unwrap();
        db.append_progress_event(
            TASK_ID,
            NewProgressEvent {
                id: "44000000-0000-0000-0000-000000000005",
                kind: ProgressEventKind::Progress,
                summary: "Waiting for approval",
                step_status: Some(WorkStatus::Pending),
            },
            2,
            metadata("append-persistent-step"),
        )
        .unwrap();
    }

    let db = Database::open(&path).unwrap();
    assert_eq!(db.node_count(NodeKind::Root).unwrap(), 1);
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 1);
    assert_eq!(db.node_status(TASK_ID).unwrap(), "review");
    assert_eq!(db.progress_event_count(TASK_ID).unwrap(), 4);
    assert_eq!(
        db.recent_progress_events(TASK_ID, 1).unwrap()[0]
            .step_status
            .as_deref(),
        Some("pending")
    );
    assert_eq!(node_location(&db, TASK_ID).1, 0);
    assert_eq!(node_location(&db, PROJECT_ID).1, 1);
    assert_eq!(
        db.list_today()
            .unwrap()
            .iter()
            .map(|item| item.node_id.as_str())
            .collect::<Vec<_>>(),
        vec![TASK_ID, PROJECT_ID]
    );
    assert_eq!(
        db.connection
            .query_row("SELECT COUNT(*) FROM today_items", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
    assert_eq!(
        db.connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}

#[test]
fn changed_applied_migration_checksum_stops_startup() {
    let directory = tempdir().unwrap();
    for version in [1, 2] {
        let path = directory.path().join(format!("karazhan-v{version}.db"));
        let db = Database::open(&path).unwrap();
        db.connection
            .execute(
                "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = ?1",
                [version],
            )
            .unwrap();
        drop(db);

        assert!(matches!(
            Database::open(&path),
            Err(DomainError::MigrationChecksum {
                version: actual_version
            }) if actual_version == version
        ));
    }
}

#[test]
fn failed_migration_rolls_back_every_statement() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               checksum TEXT NOT NULL,
               applied_at TEXT NOT NULL
             ) STRICT;",
        )
        .unwrap();

    let result = apply_migration(
        &mut connection,
        99,
        "CREATE TABLE should_rollback (id INTEGER); THIS IS INVALID SQL;",
    );
    assert!(result.is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'should_rollback'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 99",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn concurrent_process_migration_lock_returns_migration_busy() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("karazhan.db");
    let lock_path = migration_lock_path(&path);
    let competing_process = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .unwrap();
    competing_process.try_lock().unwrap();

    assert!(matches!(
        Database::open(&path),
        Err(DomainError::MigrationBusy)
    ));
    drop(competing_process);

    let db = Database::open(&path).unwrap();
    assert_eq!(db.node_count(NodeKind::Root).unwrap(), 1);
}

#[test]
fn pending_migration_checkpoints_wal_and_creates_verified_online_backup() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("karazhan.db");
    let mut connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               checksum TEXT NOT NULL,
               applied_at TEXT NOT NULL
             ) STRICT;",
        )
        .unwrap();
    apply_migration(&mut connection, 1, CORE_MIGRATION_1).unwrap();
    connection
        .execute(
            "INSERT INTO work_nodes (
               id, kind, parent_id, key, title, work_status, priority, position,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, 'project', ?2, 'before-upgrade', 'Before upgrade',
               'planned', 'none', 0,
               '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z',
               'user', 'user', 'ui', 1
             )",
            params![PROJECT_ID, SYSTEM_ROOT_ID],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO projects (node_id, slug, context_path) VALUES (?1, NULL, NULL)",
            [PROJECT_ID],
        )
        .unwrap();
    drop(connection);

    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    drop(db);

    let backups: Vec<_> = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|entry| {
            entry
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("karazhan.db.pre-migration-v2-")
                && entry.extension().and_then(|value| value.to_str()) == Some("sqlite3")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open(&backups[0]).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT COUNT(*) FROM work_nodes WHERE id = ?1",
                [PROJECT_ID],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn backup_modify_restore_round_trip_validates_counts_and_preserves_failed_restore() {
    let directory = tempdir().unwrap();
    let target_path = directory.path().join("karazhan.db");
    let backup_path = directory.path().join("karazhan.backup.sqlite3");
    {
        let mut db = Database::open(&target_path).unwrap();
        create(
            &mut db,
            node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
        )
        .unwrap();
        let backup_counts = db.backup_to(&backup_path).unwrap();
        assert_eq!(backup_counts.work_nodes, 2);
        assert_eq!(backup_counts.projects, 1);
        assert_eq!(backup_counts.tasks, 0);
        create(
            &mut db,
            node(TASK_ID, NodeKind::Task, PROJECT_ID, "after-backup", 0),
        )
        .unwrap();
    }

    let restored = Database::restore_from(&target_path, &backup_path).unwrap();
    assert_eq!(restored.counts.work_nodes, 2);
    assert_eq!(restored.counts.projects, 1);
    assert_eq!(restored.counts.tasks, 0);
    let db = Database::open(&target_path).unwrap();
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 0);
    drop(db);

    let invalid_backup_path = directory.path().join("invalid.backup.sqlite3");
    {
        let db = Database::open(&target_path).unwrap();
        db.backup_to(&invalid_backup_path).unwrap();
    }
    let invalid_backup = Connection::open(&invalid_backup_path).unwrap();
    invalid_backup
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    invalid_backup
        .execute("DELETE FROM work_nodes WHERE id = ?1", [PROJECT_ID])
        .unwrap();
    drop(invalid_backup);

    let failed = Database::restore_from(&target_path, &invalid_backup_path);
    let diagnostic_path = match failed {
        Err(DomainError::RestoreValidation {
            diagnostic_path, ..
        }) => diagnostic_path,
        other => panic!("unexpected restore result: {other:?}"),
    };
    assert!(diagnostic_path.exists());
    let db = Database::open(&target_path).unwrap();
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 0);
}

#[test]
fn create_and_status_commands_are_idempotent_and_preserve_metadata() {
    let mut db = Database::open_in_memory().unwrap();
    let command = node(TASK_ID, NodeKind::Task, SYSTEM_ROOT_ID, "task", 0);
    let first = db
        .create_node(command.clone(), metadata("create-task-once"))
        .unwrap();
    let replay = db
        .create_node(command, metadata("create-task-once"))
        .unwrap();
    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 1);

    let first_status = db
        .update_status(
            TASK_ID,
            WorkStatus::Review,
            1,
            EVENT_ID,
            metadata("status-review-once"),
        )
        .unwrap();
    let replay_status = db
        .update_status(
            TASK_ID,
            WorkStatus::Review,
            1,
            EVENT_ID,
            metadata("status-review-once"),
        )
        .unwrap();
    assert!(!first_status.replayed);
    assert!(replay_status.replayed);
    assert_eq!(replay_status.revision, 2);
    assert_eq!(db.progress_event_count(TASK_ID).unwrap(), 1);

    let recorded: (String, String, String, String) = db
        .connection
        .query_row(
            "SELECT n.created_actor, n.write_source, e.actor_type, e.channel
             FROM work_nodes n JOIN progress_events e ON e.subject_node_id = n.id
             WHERE n.id = ?1",
            [TASK_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        recorded,
        (
            "custodian".into(),
            "mcp".into(),
            "task_agent".into(),
            "mcp".into()
        )
    );
}

#[test]
fn reused_idempotency_key_with_different_request_is_rejected() {
    let mut db = Database::open_in_memory().unwrap();
    db.create_node(
        node(TASK_ID, NodeKind::Task, SYSTEM_ROOT_ID, "first", 0),
        metadata("same-key"),
    )
    .unwrap();

    let conflict = db.create_node(
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "different", 0),
        metadata("same-key"),
    );
    assert!(matches!(conflict, Err(DomainError::IdempotencyConflict)));
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 1);
}

#[test]
fn formal_schema_v1_contains_all_tables_indexes_and_guards() {
    let db = Database::open_in_memory().unwrap();
    assert_eq!(
        db.connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        db.connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        5
    );
    let tables = schema_objects(&db.connection, "table");
    assert_eq!(
        tables,
        vec![
            "backlog_items",
            "command_receipts",
            "import_records",
            "import_runs",
            "import_source_records",
            "progress_events",
            "projects",
            "resource_bindings",
            "schema_migrations",
            "tasks",
            "today_items",
            "work_nodes",
        ]
    );

    let indexes = schema_objects(&db.connection, "index");
    for expected in [
        "one_primary_resource_per_kind",
        "one_system_root",
        "progress_event_source_identity",
        "progress_events_subject_occurred",
        "resource_bindings_locator",
        "tasks_quick_item",
        "work_nodes_kind_status",
        "work_nodes_archive_parent_position",
        "work_nodes_parent_position",
    ] {
        assert!(
            indexes.iter().any(|name| name == expected),
            "missing {expected}"
        );
    }

    let triggers = schema_objects(&db.connection, "trigger");
    assert_eq!(triggers.len(), 23);
    for expected in [
        "backlog_promoted_target_insert_guard",
        "backlog_promoted_target_update_guard",
        "progress_event_source_binding_guard",
        "progress_event_source_binding_update_guard",
        "resource_binding_identity_immutable",
        "resource_binding_target_kind_guard",
        "today_node_kind_update_guard",
        "today_archived_node_guard",
        "work_nodes_archived_parent_insert_guard",
        "work_nodes_archived_parent_update_guard",
    ] {
        assert!(
            triggers.iter().any(|name| name == expected),
            "missing {expected}"
        );
    }
    assert_eq!(
        schema_objects(&db.connection, "view"),
        vec!["schema_invariant_violations"]
    );
}

#[test]
fn resource_binding_identity_and_progress_source_ownership_are_enforced() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "idea", 1),
    )
    .unwrap();

    let project_binding = "50000000-0000-0000-0000-000000000001";
    let task_binding = "50000000-0000-0000-0000-000000000002";
    insert_binding(&db.connection, project_binding, PROJECT_ID, "/tmp/shared").unwrap();
    insert_binding(&db.connection, task_binding, TASK_ID, "/tmp/shared").unwrap();

    let backlog_binding = insert_binding(
        &db.connection,
        "50000000-0000-0000-0000-000000000003",
        BACKLOG_ID,
        "/tmp/backlog",
    );
    assert!(
        backlog_binding
            .unwrap_err()
            .to_string()
            .contains("resource_binding_target_kind_mismatch")
    );

    let mutate_identity = db.connection.execute(
        "UPDATE resource_bindings SET locator = '/tmp/changed' WHERE id = ?1",
        [project_binding],
    );
    assert!(
        mutate_identity
            .unwrap_err()
            .to_string()
            .contains("resource_binding_identity_immutable")
    );

    let wrong_source = db.connection.execute(
        "INSERT INTO progress_events (
           id, subject_node_id, occurred_at, recorded_at, event_type, summary,
           evidence_json, actor_type, channel, source_binding_id, source_item_key, source_digest
         ) VALUES (?1, ?2, '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z',
                   'imported', 'imported event', '[]', 'system', 'import', ?3, 'section:1', 'abc')",
        params![
            "40000000-0000-0000-0000-000000000003",
            TASK_ID,
            project_binding
        ],
    );
    assert!(
        wrong_source
            .unwrap_err()
            .to_string()
            .contains("progress_event_source_binding_mismatch")
    );
}

#[test]
fn resource_bindings_support_shared_locators_and_availability_updates() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    let shared_locator = "/trusted/shared-workspace";
    let project_binding_id = "50000000-0000-0000-0000-000000000010";
    let task_binding_id = "50000000-0000-0000-0000-000000000011";

    let project_binding = NewResourceBinding {
        id: project_binding_id,
        node_id: PROJECT_ID,
        kind: ResourceKind::Workspace,
        locator: shared_locator,
        is_primary: true,
        availability: ResourceAvailability::Available,
        source: "user",
    };
    db.add_resource_binding(project_binding, metadata("binding-add-project"))
        .unwrap();
    let task_binding = NewResourceBinding {
        id: task_binding_id,
        node_id: TASK_ID,
        kind: ResourceKind::Workspace,
        locator: shared_locator,
        is_primary: true,
        availability: ResourceAvailability::Available,
        source: "user",
    };
    db.add_resource_binding(task_binding, metadata("binding-add-task"))
        .unwrap();

    let replay = db
        .add_resource_binding(task_binding, metadata("binding-add-task"))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(db.list_resource_bindings(PROJECT_ID).unwrap().len(), 1);
    assert_eq!(db.list_resource_bindings(TASK_ID).unwrap().len(), 1);

    db.update_resource_availability(
        project_binding_id,
        ResourceAvailability::Missing,
        1,
        metadata("binding-project-missing"),
    )
    .unwrap();
    let bindings = db.list_resource_bindings(PROJECT_ID).unwrap();
    assert_eq!(bindings[0].availability, "missing");
    assert_eq!(bindings[0].revision, 2);
    assert_eq!(bindings[0].updated_actor, "custodian");
    assert_eq!(bindings[0].write_source, "mcp");
    assert!(!bindings[0].created_at.is_empty());
    assert!(!bindings[0].updated_at.is_empty());
    assert_eq!(bindings[0].locator, shared_locator);
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
    assert_eq!(db.get_project(PROJECT_ID).unwrap().id, PROJECT_ID);

    let second_primary = db.add_resource_binding(
        NewResourceBinding {
            id: "50000000-0000-0000-0000-000000000012",
            node_id: PROJECT_ID,
            kind: ResourceKind::Workspace,
            locator: "/trusted/other-workspace",
            is_primary: true,
            availability: ResourceAvailability::Unknown,
            source: "user",
        },
        metadata("binding-second-primary"),
    );
    assert!(matches!(
        second_primary,
        Err(DomainError::PrimaryResourceConflict)
    ));

    let stale = db.update_resource_availability(
        project_binding_id,
        ResourceAvailability::Unreadable,
        1,
        metadata("binding-project-stale"),
    );
    assert!(matches!(
        stale,
        Err(DomainError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert!(matches!(
        db.update_resource_availability(
            "50000000-0000-0000-0000-000000000099",
            ResourceAvailability::Missing,
            1,
            metadata("binding-missing")
        ),
        Err(DomainError::NotFound)
    ));
}

#[test]
fn backlog_promotion_and_import_json_constraints_are_enforced() {
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "idea", 0),
    )
    .unwrap();

    db.connection
        .execute(
            "UPDATE backlog_items
             SET backlog_status = 'promoted', promoted_node_id = ?1
             WHERE node_id = ?2",
            params![PROJECT_ID, BACKLOG_ID],
        )
        .unwrap();

    let invalid_target = db.connection.execute(
        "UPDATE backlog_items SET promoted_node_id = ?1 WHERE node_id = ?2",
        params![BACKLOG_ID, BACKLOG_ID],
    );
    assert!(
        invalid_target
            .unwrap_err()
            .to_string()
            .contains("invalid_promoted_target_kind")
    );

    let invalid_scope = db.connection.execute(
        "INSERT INTO import_runs (
           id, mode, source_root, scope_json, ruleset_version, started_at, status
         ) VALUES (?1, 'dry_run', '/trusted', '[]', 'v1', '2026-09-21T00:00:00Z', 'running')",
        ["60000000-0000-0000-0000-000000000001"],
    );
    assert!(invalid_scope.is_err());
}

#[test]
fn backlog_edit_discard_and_promotion_are_atomic_and_idempotent() {
    let mut db = Database::open_in_memory().unwrap();
    let second_backlog_id = "30000000-0000-0000-0000-000000000002";
    let failed_backlog_id = "30000000-0000-0000-0000-000000000003";
    let project_backlog_id = "30000000-0000-0000-0000-000000000004";
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "idea", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            second_backlog_id,
            NodeKind::Backlog,
            PROJECT_ID,
            "request",
            1,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            failed_backlog_id,
            NodeKind::Backlog,
            PROJECT_ID,
            "failed",
            2,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            project_backlog_id,
            NodeKind::Backlog,
            PROJECT_ID,
            "project-candidate",
            4,
        ),
    )
    .unwrap();

    db.update_backlog(
        BACKLOG_ID,
        BacklogPatch {
            title: Some("Edited idea"),
            notes: TextChange::Set("Saved notes"),
            kind: Some(BacklogKind::Research),
            priority: Some(Priority::High),
            tags_json: Some("[\"rust\",\"sqlite\"]"),
        },
        1,
        metadata("backlog-edit"),
    )
    .unwrap();
    let edited = db.get_backlog(BACKLOG_ID).unwrap();
    assert_eq!(edited.title, "Edited idea");
    assert_eq!(edited.notes.as_deref(), Some("Saved notes"));
    assert_eq!(edited.backlog_kind, "research");
    assert_eq!(edited.priority, "high");
    assert_eq!(edited.tags_json, "[\"rust\",\"sqlite\"]");
    assert_eq!(edited.revision, 2);

    db.discard_backlog(BACKLOG_ID, 2, metadata("backlog-discard"))
        .unwrap();
    let discarded = db.get_backlog(BACKLOG_ID).unwrap();
    assert_eq!(discarded.backlog_status, "discarded");
    assert_eq!(discarded.revision, 3);
    assert_eq!(db.node_count(NodeKind::Backlog).unwrap(), 4);
    let invalid_tags = db.update_backlog(
        BACKLOG_ID,
        BacklogPatch {
            tags_json: Some("not-json"),
            ..BacklogPatch::default()
        },
        3,
        metadata("backlog-invalid-tags"),
    );
    assert!(matches!(invalid_tags, Err(DomainError::InvalidJson)));
    assert_eq!(db.get_backlog(BACKLOG_ID).unwrap().revision, 3);

    let target = NewTask {
        id: TASK_ID,
        parent_id: PROJECT_ID,
        key: "promoted-task",
        title: "Promoted task",
        position: 3,
    };
    let promoted = db
        .promote_backlog(
            second_backlog_id,
            PromotionTarget::Task(target.clone()),
            1,
            metadata("backlog-promote-task"),
        )
        .unwrap();
    assert_eq!(promoted.target_node_id, TASK_ID);
    assert!(!promoted.replayed);
    let replay = db
        .promote_backlog(
            second_backlog_id,
            PromotionTarget::Task(target),
            1,
            metadata("backlog-promote-task"),
        )
        .unwrap();
    assert!(replay.replayed);
    let conflicting_replay = db.promote_backlog(
        second_backlog_id,
        PromotionTarget::Task(NewTask {
            id: TASK_ID,
            parent_id: PROJECT_ID,
            key: "promoted-task",
            title: "Changed retry payload",
            position: 3,
        }),
        1,
        metadata("backlog-promote-task"),
    );
    assert!(matches!(
        conflicting_replay,
        Err(DomainError::IdempotencyConflict)
    ));
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 1);
    let source = db.get_backlog(second_backlog_id).unwrap();
    assert_eq!(source.backlog_status, "promoted");
    assert_eq!(source.promoted_node_id.as_deref(), Some(TASK_ID));
    assert_eq!(source.revision, 2);

    let failed = db.promote_backlog(
        failed_backlog_id,
        PromotionTarget::Task(NewTask {
            id: TASK_ID,
            parent_id: PROJECT_ID,
            key: "duplicate-id",
            title: "Must fail",
            position: 4,
        }),
        1,
        metadata("backlog-promote-failure"),
    );
    assert!(failed.is_err());
    let unchanged = db.get_backlog(failed_backlog_id).unwrap();
    assert_eq!(unchanged.backlog_status, "captured");
    assert_eq!(unchanged.promoted_node_id, None);
    assert_eq!(unchanged.revision, 1);

    let promoted_project_id = "10000000-0000-0000-0000-000000000002";
    db.promote_backlog(
        project_backlog_id,
        PromotionTarget::Project(NewProject {
            id: promoted_project_id,
            parent_id: SYSTEM_ROOT_ID,
            key: "promoted-project",
            title: "Promoted project",
            position: 1,
            slug: None,
            context_path: None,
        }),
        1,
        metadata("backlog-promote-project"),
    )
    .unwrap();
    assert_eq!(
        db.get_project(promoted_project_id).unwrap().title,
        "Promoted project"
    );
    assert_eq!(
        db.get_backlog(project_backlog_id)
            .unwrap()
            .promoted_node_id
            .as_deref(),
        Some(promoted_project_id)
    );
}

#[test]
fn backlog_projection_filters_and_orders_with_root_hidden_parent_breadcrumbs() {
    let mut db = Database::open_in_memory().unwrap();
    let nested_project_id = "10000000-0000-0000-0000-000000000002";
    let project_backlog_id = "30000000-0000-0000-0000-000000000002";
    let root_backlog_id = "30000000-0000-0000-0000-000000000003";
    let promoted_backlog_id = "30000000-0000-0000-0000-000000000004";
    let promoted_task_id = "20000000-0000-0000-0000-000000000002";

    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "platform", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(
            nested_project_id,
            NodeKind::Project,
            PROJECT_ID,
            "desktop",
            0,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, nested_project_id, "workflow", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, TASK_ID, "later", 2),
    )
    .unwrap();
    create(
        &mut db,
        node(project_backlog_id, NodeKind::Backlog, TASK_ID, "first", 1),
    )
    .unwrap();
    create(
        &mut db,
        node(
            root_backlog_id,
            NodeKind::Backlog,
            SYSTEM_ROOT_ID,
            "root-idea",
            1,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            promoted_backlog_id,
            NodeKind::Backlog,
            TASK_ID,
            "promoted",
            3,
        ),
    )
    .unwrap();

    db.update_backlog(
        project_backlog_id,
        BacklogPatch {
            kind: Some(BacklogKind::Research),
            priority: Some(Priority::High),
            tags_json: Some("[\"rust\",\"desktop\"]"),
            ..BacklogPatch::default()
        },
        1,
        metadata("projection-edit"),
    )
    .unwrap();
    db.discard_backlog(BACKLOG_ID, 1, metadata("projection-discard"))
        .unwrap();
    db.promote_backlog(
        promoted_backlog_id,
        PromotionTarget::Task(NewTask {
            id: promoted_task_id,
            parent_id: nested_project_id,
            key: "promoted-task",
            title: "Promoted task",
            position: 1,
        }),
        1,
        metadata("projection-promote"),
    )
    .unwrap();

    let active = db.list_backlog(&BacklogFilter::default()).unwrap();
    assert_eq!(
        active
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![root_backlog_id, project_backlog_id]
    );
    assert!(active[0].parent_breadcrumb.is_empty());
    assert_eq!(
        active[1].parent_breadcrumb,
        vec!["platform", "desktop", "workflow"]
    );
    assert_eq!(active[1].tags, vec!["rust", "desktop"]);

    let filtered = db
        .list_backlog(&BacklogFilter {
            parent_id: Some(TASK_ID.to_owned()),
            kind: Some(BacklogKind::Research),
            status: Some(BacklogStatus::Captured),
            priority: Some(Priority::High),
            tag: Some("rust".to_owned()),
        })
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, project_backlog_id);

    let discarded = db
        .list_backlog(&BacklogFilter {
            status: Some(BacklogStatus::Discarded),
            ..BacklogFilter::default()
        })
        .unwrap();
    assert_eq!(discarded.len(), 1);
    assert_eq!(discarded[0].id, BACKLOG_ID);

    db.archive_subtree(
        PROJECT_ID,
        1,
        "40000000-0000-0000-0000-000000000099",
        metadata("projection-archive-parent"),
    )
    .unwrap();
    let after_archive = db.list_backlog(&BacklogFilter::default()).unwrap();
    assert_eq!(after_archive.len(), 1);
    assert_eq!(after_archive[0].id, root_backlog_id);

    let integrity = db.integrity_report().unwrap();
    assert_eq!(integrity.integrity, "ok");
    assert_eq!(integrity.foreign_key_violations, 0);
    assert_eq!(integrity.invariant_violations, 0);
}

#[test]
fn backlog_move_is_explicit_atomic_idempotent_and_creates_no_progress_event() {
    let mut db = Database::open_in_memory().unwrap();
    let target_backlog_id = "20000000-0000-0000-0000-000000000088";
    create(
        &mut db,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, PROJECT_ID, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "idea", 1),
    )
    .unwrap();
    create(
        &mut db,
        node(
            target_backlog_id,
            NodeKind::Backlog,
            TASK_ID,
            "target-idea",
            0,
        ),
    )
    .unwrap();

    let moved = db
        .move_backlog(BACKLOG_ID, TASK_ID, Some(0), 1, metadata("move-backlog"))
        .unwrap();
    assert_eq!(moved.revision, 2);
    assert!(!moved.replayed);
    let items = db
        .list_backlog(&BacklogFilter {
            parent_id: Some(TASK_ID.into()),
            ..BacklogFilter::default()
        })
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].id, BACKLOG_ID);
    assert_eq!(items[1].id, target_backlog_id);
    let item = &items[0];
    assert_eq!(item.id, BACKLOG_ID);
    assert_eq!(item.parent_breadcrumb, vec!["project", "task"]);
    assert!(db.progress_timeline(BACKLOG_ID).unwrap().is_empty());

    let replay = db
        .move_backlog(BACKLOG_ID, TASK_ID, Some(0), 1, metadata("move-backlog"))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.revision, 2);

    let invalid = db.move_backlog(BACKLOG_ID, BACKLOG_ID, None, 2, metadata("move-invalid"));
    assert!(invalid.is_err());
    assert_eq!(db.get_backlog(BACKLOG_ID).unwrap().parent_id, TASK_ID);
}

#[test]
fn backlog_quick_add_and_today_quick_items_share_the_core_without_entering_projects() {
    let mut db = Database::open_in_memory().unwrap();
    let quick_id = "20000000-0000-0000-0000-000000000099";

    let created_backlog = db
        .create_backlog(
            NewBacklog {
                id: BACKLOG_ID,
                parent_id: SYSTEM_ROOT_ID,
                key: "capture-review-feedback",
                title: "Capture review feedback",
                notes: Some("One compact description"),
                kind: BacklogKind::Idea,
                priority: Priority::Medium,
                tags_json: "[\"review\"]",
            },
            metadata("create-backlog-ui"),
        )
        .unwrap();
    assert_eq!(created_backlog.revision, 1);
    let backlog = db.get_backlog(BACKLOG_ID).unwrap();
    assert_eq!(backlog.notes.as_deref(), Some("One compact description"));
    assert_eq!(backlog.tags_json, "[\"review\"]");

    let created_quick = db
        .create_quick_item(
            quick_id,
            "Send the review response",
            EVENT_ID,
            metadata("create-quick-item"),
        )
        .unwrap();
    assert_eq!(created_quick.revision, 1);
    let today = db.list_today().unwrap();
    assert_eq!(today.len(), 1);
    assert_eq!(today[0].node_id, quick_id);
    assert_eq!(today[0].title, "Send the review response");
    assert!(today[0].is_quick_item);
    assert!(
        db.list_project_task_tree()
            .unwrap()
            .iter()
            .all(|item| item.id != quick_id)
    );

    let replay = db
        .create_quick_item(
            quick_id,
            "Send the review response",
            EVENT_ID,
            metadata("create-quick-item"),
        )
        .unwrap();
    assert!(replay.replayed);
    let conflict = db.create_quick_item(
        quick_id,
        "Changed description",
        EVENT_ID,
        metadata("create-quick-item"),
    );
    assert!(matches!(conflict, Err(DomainError::IdempotencyConflict)));

    db.delete_quick_item(quick_id, 1, metadata("delete-quick-item"))
        .unwrap();
    assert!(db.list_today().unwrap().is_empty());
    assert_eq!(db.node_count(NodeKind::Task).unwrap(), 0);
    let integrity = db.integrity_report().unwrap();
    assert_eq!(integrity.integrity, "ok");
    assert_eq!(integrity.foreign_key_violations, 0);
    assert_eq!(integrity.invariant_violations, 0);
}

fn schema_objects(connection: &Connection, object_type: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = ?1 AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([object_type], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn insert_binding(
    connection: &Connection,
    id: &str,
    node_id: &str,
    locator: &str,
) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT INTO resource_bindings (
           id, node_id, kind, locator, is_primary, availability, source
         ) VALUES (?1, ?2, 'workspace', ?3, 0, 'available', 'test')",
        params![id, node_id, locator],
    )
}

#[test]
fn project_and_task_commands_create_read_and_list_without_optional_paths() {
    let mut db = Database::open_in_memory().unwrap();
    db.create_project(
        NewProject {
            id: PROJECT_ID,
            parent_id: SYSTEM_ROOT_ID,
            key: "karazhan",
            title: "Karazhan",
            position: 0,
            slug: None,
            context_path: None,
        },
        metadata("create-project-contract"),
    )
    .unwrap();
    db.create_task(
        NewTask {
            id: TASK_ID,
            parent_id: PROJECT_ID,
            key: "foundation",
            title: "Build foundation",
            position: 0,
        },
        metadata("create-task-contract"),
    )
    .unwrap();

    assert_eq!(
        db.get_project(PROJECT_ID).unwrap(),
        Project {
            id: PROJECT_ID.into(),
            parent_id: SYSTEM_ROOT_ID.into(),
            key: "karazhan".into(),
            title: "Karazhan".into(),
            summary: None,
            goal: None,
            acceptance: None,
            status: "planned".into(),
            priority: "none".into(),
            blocker: None,
            slug: None,
            context_path: None,
            revision: 1,
        }
    );
    assert_eq!(
        db.list_projects().unwrap(),
        vec![db.get_project(PROJECT_ID).unwrap()]
    );
    assert_eq!(
        db.get_task(TASK_ID).unwrap(),
        Task {
            id: TASK_ID.into(),
            parent_id: PROJECT_ID.into(),
            key: "foundation".into(),
            title: "Build foundation".into(),
            summary: None,
            goal: None,
            acceptance: None,
            status: "planned".into(),
            priority: "none".into(),
            blocker: None,
            revision: 1,
            has_steps: false,
        }
    );
    assert_eq!(
        db.list_tasks().unwrap(),
        vec![db.get_task(TASK_ID).unwrap()]
    );
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM resource_bindings WHERE node_id = ?1",
                [PROJECT_ID],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn project_slug_is_unique_and_a_conflicting_create_rolls_back() {
    let mut db = Database::open_in_memory().unwrap();
    db.create_project(
        NewProject {
            id: PROJECT_ID,
            parent_id: SYSTEM_ROOT_ID,
            key: "first-project",
            title: "First Project",
            position: 0,
            slug: Some("shared-slug"),
            context_path: None,
        },
        metadata("create-first-slugged-project"),
    )
    .unwrap();

    let conflicting_id = "10000000-0000-0000-0000-000000000099";
    let conflict = db.create_project(
        NewProject {
            id: conflicting_id,
            parent_id: SYSTEM_ROOT_ID,
            key: "second-project",
            title: "Second Project",
            position: 1,
            slug: Some("shared-slug"),
            context_path: None,
        },
        metadata("create-conflicting-slugged-project"),
    );

    assert!(conflict.is_err());
    assert_eq!(db.node_count(NodeKind::Project).unwrap(), 1);
    assert!(matches!(
        db.get_project(conflicting_id),
        Err(DomainError::NotFound)
    ));
}

#[test]
fn pending_is_valid_waiting_is_rejected_and_blocker_is_independent() {
    let mut db = Database::open_in_memory().unwrap();
    db.create_task(
        NewTask {
            id: TASK_ID,
            parent_id: SYSTEM_ROOT_ID,
            key: "pending-task",
            title: "Pending Task",
            position: 0,
        },
        metadata("create-pending-task"),
    )
    .unwrap();
    db.update_work_item(
        TASK_ID,
        WorkItemPatch {
            status: Some(WorkStatus::Pending),
            blocker: TextChange::Set("External dependency"),
            ..WorkItemPatch::default()
        },
        1,
        "41000000-0000-0000-0000-000000000099",
        metadata("set-pending-with-blocker"),
    )
    .unwrap();

    let task = db.get_task(TASK_ID).unwrap();
    assert_eq!(task.status, "pending");
    assert_eq!(task.blocker.as_deref(), Some("External dependency"));

    let waiting = db.connection.execute(
        "UPDATE work_nodes SET work_status = 'waiting' WHERE id = ?1",
        [TASK_ID],
    );
    assert!(waiting.is_err());
    let unchanged = db.get_task(TASK_ID).unwrap();
    assert_eq!(unchanged.status, "pending");
    assert_eq!(unchanged.blocker.as_deref(), Some("External dependency"));
}

#[test]
fn legacy_dry_run_reads_only_explicit_scoped_sources_and_never_writes_database() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    let outside = temporary.path().join("outside.yaml");
    std::fs::create_dir_all(trusted.join("registry")).unwrap();
    std::fs::create_dir_all(trusted.join("task/.workbench")).unwrap();
    std::fs::create_dir_all(trusted.join("task/context")).unwrap();
    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        "projects:\n  - slug: fixture\ntasks:\n  - id: 94000000-0000-0000-0000-000000000001\n    project_slug: fixture\n",
    )
    .unwrap();
    std::fs::write(trusted.join("registry/backlog.yaml"), "items: []\n").unwrap();
    std::fs::write(
        trusted.join("task/.workbench/task.yaml"),
        "id: 94000000-0000-0000-0000-000000000001\n",
    )
    .unwrap();
    std::fs::write(
        trusted.join("task/agent_log.md"),
        "## Started\nSafe summary\n",
    )
    .unwrap();
    std::fs::write(trusted.join("task/context/private-key.pem"), "TOP-SECRET").unwrap();
    std::fs::write(trusted.join("unscoped.txt"), "UNSCOPED").unwrap();
    std::fs::write(&outside, "OUTSIDE").unwrap();

    let scope = LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: vec!["task/.workbench/task.yaml".into()],
        agent_logs: vec!["task/agent_log.md".into()],
        project_contexts: vec!["task/context".into(), "missing/context".into()],
    };
    let db = Database::open_in_memory().unwrap();
    let counts_before = validate_database(&db.connection).unwrap();

    let first = dry_run_legacy_source(&trusted, &scope).unwrap();
    let second = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.ruleset_version, LEGACY_RULESET_VERSION);
    assert!(first.apply_eligible);
    assert_eq!(
        first
            .source_files
            .iter()
            .map(|record| (record.source_kind.as_str(), record.locator.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("agent_log", "task/agent_log.md"),
            ("backlog_registry", "registry/backlog.yaml"),
            ("task_manifest", "task/.workbench/task.yaml"),
            ("tasks_registry", "registry/tasks.yaml"),
        ]
    );
    assert_eq!(
        first
            .project_contexts
            .iter()
            .map(|record| (record.locator.as_str(), record.exists))
            .collect::<Vec<_>>(),
        vec![("missing/context", false), ("task/context", true)]
    );
    assert_eq!(first.source_snapshot_digest.len(), 64);
    assert_eq!(first.report_digest.len(), 64);
    let rendered = serde_json::to_string(&first).unwrap();
    assert!(!rendered.contains("TOP-SECRET"));
    assert!(!rendered.contains("private-key.pem"));
    assert!(!rendered.contains("UNSCOPED"));
    assert!(!rendered.contains("OUTSIDE"));
    assert_eq!(validate_database(&db.connection).unwrap(), counts_before);
    assert_eq!(
        db.connection
            .query_row("SELECT COUNT(*) FROM import_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    std::fs::write(trusted.join("unscoped.txt"), "CHANGED-UNSCOPED").unwrap();
    std::fs::write(
        trusted.join("task/context/private-key.pem"),
        "CHANGED-SECRET",
    )
    .unwrap();
    assert_eq!(dry_run_legacy_source(&trusted, &scope).unwrap(), first);

    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        "projects:\n  - slug: fixture\ntasks:\n  - id: 94000000-0000-0000-0000-000000000001\n    project_slug: fixture\n# changed source snapshot\n",
    )
    .unwrap();
    let changed = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert_ne!(changed.source_snapshot_digest, first.source_snapshot_digest);
    assert_ne!(changed.report_digest, first.report_digest);

    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        "projects:\n  - slug: fixture\ntasks:\n  - id: 94000000-0000-0000-0000-000000000001\n    project_slug: fixture\n",
    )
    .unwrap();
    let application = crate::application::Application::new(Database::open_in_memory().unwrap());
    let through_contract = application
        .query(crate::application::Query::LegacyDryRun {
            source_root: trusted.display().to_string(),
            scope: scope.clone(),
        })
        .unwrap();
    assert!(matches!(
        through_contract,
        crate::application::QueryResult::LegacyDryRun(report) if *report == first
    ));
}

#[test]
fn legacy_dry_run_rejects_absolute_parent_and_symlink_scope_escapes() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    std::fs::create_dir_all(trusted.join("registry")).unwrap();
    std::fs::write(trusted.join("registry/tasks.yaml"), "tasks: []\n").unwrap();
    std::fs::write(trusted.join("registry/backlog.yaml"), "items: []\n").unwrap();
    let base = LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: vec![],
        agent_logs: vec![],
        project_contexts: vec![],
    };

    let mut absolute = base.clone();
    absolute.tasks_registry = temporary.path().join("outside.yaml").display().to_string();
    assert!(matches!(
        dry_run_legacy_source(&trusted, &absolute),
        Err(DomainError::ImportScopeMustBeRelative { .. })
    ));

    let mut parent = base.clone();
    parent.agent_logs.push("../outside.md".into());
    assert!(matches!(
        dry_run_legacy_source(&trusted, &parent),
        Err(DomainError::ImportScopeOutsideRoot { .. })
    ));

    #[cfg(unix)]
    {
        let outside = temporary.path().join("outside.md");
        std::fs::write(&outside, "outside").unwrap();
        std::fs::create_dir_all(trusted.join("escaped")).unwrap();
        std::os::unix::fs::symlink(&outside, trusted.join("escaped/agent_log.md")).unwrap();
        let mut symlink = base;
        symlink.agent_logs.push("escaped/agent_log.md".into());
        assert!(matches!(
            dry_run_legacy_source(&trusted, &symlink),
            Err(DomainError::ImportScopeOutsideRoot { .. })
        ));
    }
}

#[test]
fn legacy_dry_run_never_reads_context_or_coordination_content() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    std::fs::create_dir_all(trusted.join("registry")).unwrap();
    std::fs::create_dir_all(trusted.join("project/context")).unwrap();
    std::fs::create_dir_all(trusted.join("project/coordination")).unwrap();
    std::fs::write(trusted.join("registry/tasks.yaml"), "tasks: []\n").unwrap();
    std::fs::write(trusted.join("registry/backlog.yaml"), "items: []\n").unwrap();
    std::fs::write(
        trusted.join("project/context/agent_log.md"),
        "CONTEXT-BODY-SECRET",
    )
    .unwrap();
    std::fs::write(
        trusted.join("project/coordination/agent_log.md"),
        "COORDINATION-BODY-SECRET",
    )
    .unwrap();

    let base = LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: vec![],
        agent_logs: vec![],
        project_contexts: vec!["project/context".into()],
    };
    let first = dry_run_legacy_source(&trusted, &base).unwrap();
    let rendered = serde_json::to_string(&first).unwrap();
    assert!(!rendered.contains("CONTEXT-BODY-SECRET"));
    assert!(!rendered.contains("COORDINATION-BODY-SECRET"));

    std::fs::write(
        trusted.join("project/context/agent_log.md"),
        "CHANGED-CONTEXT-BODY-SECRET",
    )
    .unwrap();
    std::fs::write(
        trusted.join("project/coordination/agent_log.md"),
        "CHANGED-COORDINATION-BODY-SECRET",
    )
    .unwrap();
    assert_eq!(dry_run_legacy_source(&trusted, &base).unwrap(), first);

    for protected_locator in [
        "project/context/agent_log.md",
        "project/coordination/agent_log.md",
    ] {
        let mut scoped = base.clone();
        scoped.agent_logs.push(protected_locator.into());
        let error = dry_run_legacy_source(&trusted, &scoped).unwrap_err();
        assert!(matches!(error, DomainError::ImportProtectedSource { .. }));
        let message = error.to_string();
        assert!(!message.contains("CHANGED-CONTEXT-BODY-SECRET"));
        assert!(!message.contains("CHANGED-COORDINATION-BODY-SECRET"));
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            trusted.join("project/context/agent_log.md"),
            trusted.join("project/agent_log.md"),
        )
        .unwrap();
        let mut scoped = base;
        scoped.agent_logs.push("project/agent_log.md".into());
        let error = dry_run_legacy_source(&trusted, &scoped).unwrap_err();
        assert!(matches!(error, DomainError::ImportProtectedSource { .. }));
        assert!(!error.to_string().contains("CHANGED-CONTEXT-BODY-SECRET"));
    }

    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        "tasks: [\nMALFORMED-BODY-SECRET",
    )
    .unwrap();
    let error = dry_run_legacy_source(
        &trusted,
        &LegacyDryRunScope {
            tasks_registry: "registry/tasks.yaml".into(),
            backlog_registry: "registry/backlog.yaml".into(),
            task_manifests: vec![],
            agent_logs: vec![],
            project_contexts: vec![],
        },
    )
    .unwrap_err();
    assert!(matches!(error, DomainError::ImportSourceMalformed { .. }));
    assert!(!error.to_string().contains("MALFORMED-BODY-SECRET"));
}

#[test]
fn legacy_identity_mapping_preserves_tasks_and_builds_deterministic_projects_and_actions() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    std::fs::create_dir_all(trusted.join("registry")).unwrap();
    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        r#"projects:
  - slug: fixture
    title: Fixture Project
  - slug: second
tasks:
  - id: 91000000-0000-0000-0000-000000000001
    project_slug: fixture
    key: root-task
    title: Root Task
    next_action: Review result
  - id: 91000000-0000-0000-0000-000000000002
    project_slug: fixture
    parent_id: 91000000-0000-0000-0000-000000000001
    key: child-task
    title: Existing Child
    next_action: "   "
  - id: 91000000-0000-0000-0000-000000000004
    project_slug: second
    key: second-root
    title: Second Root
"#,
    )
    .unwrap();
    std::fs::write(trusted.join("registry/backlog.yaml"), "items: []\n").unwrap();
    let scope = LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: vec![],
        agent_logs: vec![],
        project_contexts: vec![],
    };

    let report = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert_eq!(report.summary.legacy_projects, 2);
    assert_eq!(report.summary.legacy_tasks, 3);
    assert_eq!(report.summary.next_action_tasks, 1);
    assert_eq!(
        report
            .project_mappings
            .iter()
            .map(|mapping| (mapping.source_slug.as_str(), mapping.target_id.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("fixture", "c00463ba-74c1-59a1-a1d0-2d669df028d4"),
            ("second", "e4bd8025-18df-5fc3-bdd6-533597ae9402"),
        ]
    );
    assert_eq!(report.project_mappings[0].parent_id, SYSTEM_ROOT_ID);
    assert_eq!(report.project_mappings[0].title, "Fixture Project");

    let root = &report.legacy_task_mappings[0];
    assert_eq!(root.source_id, root.target_id);
    assert_eq!(root.parent_id, report.project_mappings[0].target_id);
    let child = &report.legacy_task_mappings[1];
    assert_eq!(child.source_id, child.target_id);
    assert_eq!(child.parent_id, root.target_id);
    let second_root = &report.legacy_task_mappings[2];
    assert_eq!(second_root.parent_id, report.project_mappings[1].target_id);

    assert_eq!(report.legacy_next_action_task_mappings.len(), 1);
    let action = &report.legacy_next_action_task_mappings[0];
    assert_eq!(action.source_task_id, root.source_id);
    assert_eq!(action.target_id, "5d7022aa-2851-51a1-9a66-cb6c001fab12");
    assert_eq!(action.parent_id, root.target_id);
    assert_eq!(action.title, "Review result");
    assert_eq!(action.work_status, "planned");
    assert_eq!(action.priority, "none");
    assert!(
        serde_json::to_value(root)
            .unwrap()
            .get("next_action")
            .is_none()
    );
    assert_eq!(dry_run_legacy_source(&trusted, &scope).unwrap(), report);
}

#[test]
fn legacy_conflicts_keep_source_identities_and_choose_safe_deterministic_defaults() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    for directory in [
        "registry",
        "tasks/registered/.workbench",
        "tasks/orphan/.workbench",
        "logs/shared",
    ] {
        std::fs::create_dir_all(trusted.join(directory)).unwrap();
    }
    std::fs::write(
        trusted.join("registry/tasks.yaml"),
        r#"projects:
  - slug: fixture
tasks:
  - id: 91000000-0000-0000-0000-000000000001
    project_slug: fixture
    key: root-task
    title: Registered Root
    status: waiting
    priority: high
    workspace: workspace/shared
    manifest: tasks/registered/.workbench/task.yaml
    agent_log: logs/shared/agent_log.md
    cursor: 0
"#,
    )
    .unwrap();
    std::fs::write(
        trusted.join("registry/backlog.yaml"),
        r#"items:
  - id: 93000000-0000-0000-0000-000000000003
    project_slug: fixture
    title: Promoted idea
    kind: idea
    status: promoted
    promoted_node_id: 91000000-0000-0000-0000-000000000001
"#,
    )
    .unwrap();
    std::fs::write(
        trusted.join("tasks/registered/.workbench/task.yaml"),
        "id: 91000000-0000-0000-0000-000000000001\n",
    )
    .unwrap();
    std::fs::write(
        trusted.join("tasks/orphan/.workbench/task.yaml"),
        r#"id: 92000000-0000-0000-0000-000000000002
project_slug: fixture
key: root-task
title: Manifest-only Task
workspace: workspace/shared
agent_log: logs/shared/agent_log.md
"#,
    )
    .unwrap();
    std::fs::write(
        trusted.join("logs/shared/agent_log.md"),
        "# Log\n\n## Same heading\nfirst\n\n## Same heading\nsecond\n",
    )
    .unwrap();

    let scope = LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: vec![
            "tasks/registered/.workbench/task.yaml".into(),
            "tasks/orphan/.workbench/task.yaml".into(),
        ],
        agent_logs: vec!["logs/shared/agent_log.md".into()],
        project_contexts: vec![],
    };
    let report = dry_run_legacy_source(&trusted, &scope).unwrap();

    assert_eq!(report.legacy_task_mappings.len(), 2);
    let registered = &report.legacy_task_mappings[0];
    let orphan = &report.legacy_task_mappings[1];
    assert_eq!(registered.target_id, "91000000-0000-0000-0000-000000000001");
    assert_eq!(registered.work_status, "pending");
    assert_eq!(registered.raw_status.as_deref(), Some("waiting"));
    assert_eq!(registered.priority, "high");
    assert_eq!(orphan.target_id, "92000000-0000-0000-0000-000000000002");
    assert_eq!(orphan.key, "root-task-92000000");

    let shared_workspace = report
        .resource_binding_mappings
        .iter()
        .filter(|binding| binding.kind == "workspace" && binding.locator == "workspace/shared")
        .collect::<Vec<_>>();
    assert_eq!(shared_workspace.len(), 2);
    assert_ne!(shared_workspace[0].node_id, shared_workspace[1].node_id);
    assert_ne!(shared_workspace[0].id, shared_workspace[1].id);

    assert_eq!(report.backlog_mappings.len(), 1);
    assert_eq!(
        report.backlog_mappings[0].promoted_node_id.as_deref(),
        Some("91000000-0000-0000-0000-000000000001")
    );
    assert_eq!(report.backlog_mappings[0].backlog_status, "promoted");

    assert_eq!(report.summary.progress_events, 4);
    assert_eq!(report.progress_event_mappings.len(), 4);
    let source_identities = report
        .progress_event_mappings
        .iter()
        .map(|event| {
            (
                event.source_binding_id.as_str(),
                event.source_item_key.as_str(),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(source_identities.len(), 4);
    assert_eq!(
        report
            .progress_event_mappings
            .iter()
            .map(|event| event.id.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        4
    );
    assert_eq!(
        report
            .progress_event_mappings
            .iter()
            .filter(|event| event.source_item_key == "section:0")
            .count(),
        2
    );

    let codes = report
        .conflicts
        .iter()
        .map(|conflict| conflict.code.as_str())
        .collect::<BTreeSet<_>>();
    for required in [
        "shared_resource_locator",
        "manifest_without_registry",
        "log_cursor_behind",
        "log_cursor_missing",
        "legacy_status_mapped",
        "promotion_link_verified",
        "sibling_key_collision",
    ] {
        assert!(codes.contains(required), "missing conflict {required}");
    }
    assert!(
        report
            .conflicts
            .iter()
            .all(|conflict| conflict.severity != "blocker")
    );
    assert!(report.apply_eligible);
    assert_eq!(dry_run_legacy_source(&trusted, &scope).unwrap(), report);

    let event = report
        .progress_event_mappings
        .iter()
        .find(|event| event.subject_node_id == registered.target_id)
        .unwrap()
        .clone();
    let binding = report
        .resource_binding_mappings
        .iter()
        .find(|binding| binding.id == event.source_binding_id)
        .unwrap();
    let mut db = Database::open_in_memory().unwrap();
    create(
        &mut db,
        node(
            &report.project_mappings[0].target_id,
            NodeKind::Project,
            SYSTEM_ROOT_ID,
            "fixture",
            0,
        ),
    )
    .unwrap();
    create(
        &mut db,
        node(
            &registered.target_id,
            NodeKind::Task,
            &report.project_mappings[0].target_id,
            "root-task",
            0,
        ),
    )
    .unwrap();
    db.add_resource_binding(
        NewResourceBinding {
            id: &binding.id,
            node_id: &binding.node_id,
            kind: ResourceKind::AgentLog,
            locator: &binding.locator,
            is_primary: true,
            availability: ResourceAvailability::Available,
            source: "legacy_import",
        },
        metadata("add-import-log-binding"),
    )
    .unwrap();

    let first = db.sync_legacy_log_event(&event).unwrap();
    assert!(!first.replayed);
    let replay = db.sync_legacy_log_event(&event).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.event_id, first.event_id);
    let event_count: i64 = db
        .connection
        .query_row("SELECT COUNT(*) FROM progress_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);

    let mut changed = event.clone();
    changed.source_digest = "changed-source-digest".into();
    changed.summary = "changed source content".into();
    let error = db.sync_legacy_log_event(&changed).unwrap_err();
    assert_eq!(error.code(), "source_record_mutated");
    let preserved = db
        .connection
        .query_row(
            "SELECT summary, source_digest FROM progress_events WHERE id = ?1",
            [&event.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(preserved, (event.summary, event.source_digest));
    let current_state = db
        .connection
        .query_row(
            "SELECT work_status, revision FROM work_nodes WHERE id = ?1",
            [&registered.target_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap();
    assert_eq!(current_state, ("planned".into(), 1));
    let event_count: i64 = db
        .connection
        .query_row("SELECT COUNT(*) FROM progress_events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);
}

#[test]
fn frozen_snapshot_fixture_matches_required_counts_and_canonical_baseline() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    let scope = write_frozen_legacy_fixture(&trusted);

    let report = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert_eq!(report.summary.legacy_projects, 5);
    assert_eq!(report.summary.legacy_tasks, 13);
    assert_eq!(report.summary.next_action_tasks, 12);
    assert_eq!(report.summary.legacy_backlog_items, 3);
    assert_eq!(report.summary.work_nodes, 34);
    assert_eq!(report.summary.resource_bindings, 39);
    assert_eq!(report.summary.progress_events, 157);
    assert_eq!(report.summary.today_items, 0);
    assert!(
        report
            .progress_event_mappings
            .iter()
            .all(|event| event.subject_node_id != "10000000-0000-0000-0000-000000000000")
    );
    assert_eq!(dry_run_legacy_source(&trusted, &scope).unwrap(), report);

    let golden = include_bytes!("../tests/fixtures/frozen-report-2026-09-21.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(golden)),
        "b87311efb576fa616c273b053d06969ef808620a3e670b67027ad99f7c356196"
    );
    let golden: serde_json::Value = serde_json::from_slice(golden).unwrap();
    let summary = &golden["summary"];
    assert_eq!(summary["work_nodes_create"], report.summary.work_nodes);
    assert_eq!(
        summary["resource_bindings_create"],
        report.summary.resource_bindings
    );
    assert_eq!(
        summary["progress_events_create"],
        report.summary.progress_events
    );
    assert_eq!(summary["today_items_create"], report.summary.today_items);

    let mut log = OpenOptions::new()
        .append(true)
        .open(trusted.join("logs/source-11/agent_log.md"))
        .unwrap();
    writeln!(log, "\n## Added after baseline\nNew content").unwrap();
    drop(log);
    let changed = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert_eq!(changed.summary.progress_events, 158);
    assert_ne!(
        changed.source_snapshot_digest,
        report.source_snapshot_digest
    );
    assert_ne!(changed.report_digest, report.report_digest);
}

#[test]
fn legacy_apply_is_atomic_replayable_and_rejects_source_drift_before_writes() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    let scope = write_frozen_legacy_fixture(&trusted);
    let report = dry_run_legacy_source(&trusted, &scope).unwrap();
    assert!(report.apply_eligible);

    let mut db = Database::open_in_memory().unwrap();
    let first = db.apply_legacy_report(&report, "frozen-apply").unwrap();
    assert!(!first.replayed);
    assert_eq!(first.status, "succeeded");
    assert_eq!(first.report_digest, report.report_digest);
    assert_eq!(first.counts.work_nodes, 34);
    assert_eq!(first.counts.projects, 5);
    assert_eq!(first.counts.tasks, 25);
    assert_eq!(first.counts.backlog_items, 3);
    assert_eq!(first.counts.resource_bindings, 39);
    assert_eq!(first.counts.progress_events, 157);
    assert_eq!(first.counts.today_items, 0);

    let replay = db.apply_legacy_report(&report, "frozen-apply").unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.run_id, first.run_id);
    assert_eq!(replay.counts, first.counts);
    assert_eq!(validate_database(&db.connection).unwrap(), first.counts);
    assert_eq!(dry_run_legacy_source(&trusted, &scope).unwrap(), report);
    assert_eq!(
        db.connection
            .query_row("SELECT COUNT(*) FROM import_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    for table in ["import_records", "import_source_records"] {
        let count: i64 = db
            .connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count as usize, report.source_files.len());
    }

    let mut different_report = report.clone();
    different_report.report_digest = "0".repeat(64);
    assert!(matches!(
        db.apply_legacy_report(&different_report, "frozen-apply"),
        Err(DomainError::IdempotencyConflict)
    ));
    assert_eq!(validate_database(&db.connection).unwrap(), first.counts);

    let mut precondition_db = Database::open_in_memory().unwrap();
    let mut wrong_ruleset = report.clone();
    wrong_ruleset.ruleset_version = "different-ruleset".into();
    assert_eq!(
        precondition_db
            .apply_legacy_report(&wrong_ruleset, "wrong-ruleset")
            .unwrap_err()
            .code(),
        "ruleset_mismatch"
    );
    let mut wrong_digest = report.clone();
    wrong_digest.report_digest = "0".repeat(64);
    assert_eq!(
        precondition_db
            .apply_legacy_report(&wrong_digest, "wrong-report")
            .unwrap_err()
            .code(),
        "report_digest_mismatch"
    );
    assert_eq!(
        precondition_db
            .connection
            .query_row("SELECT COUNT(*) FROM import_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    let mut drift_db = Database::open_in_memory().unwrap();
    let mut log = OpenOptions::new()
        .append(true)
        .open(trusted.join("logs/source-11/agent_log.md"))
        .unwrap();
    writeln!(log, "\n## Source drift\nChanged after dry-run").unwrap();
    drop(log);
    let error = drift_db
        .apply_legacy_report(&report, "drifted-apply")
        .unwrap_err();
    assert_eq!(error.code(), "source_snapshot_changed");
    let counts = validate_database(&drift_db.connection).unwrap();
    assert_eq!(counts.work_nodes, 1);
    assert_eq!(counts.projects, 0);
    assert_eq!(counts.tasks, 0);
    assert_eq!(counts.backlog_items, 0);
    assert_eq!(counts.resource_bindings, 0);
    assert_eq!(counts.progress_events, 0);
    assert_eq!(counts.today_items, 0);
    assert_eq!(
        drift_db
            .connection
            .query_row("SELECT COUNT(*) FROM import_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn legacy_file_database_rehearsal_survives_failed_migration_and_restore() {
    let temporary = tempdir().unwrap();
    let trusted = temporary.path().join("trusted");
    let database_path = temporary.path().join("karazhan-rehearsal.db");
    let backup_path = temporary.path().join("karazhan-rehearsal.backup.sqlite3");
    let scope = write_frozen_legacy_fixture(&trusted);
    let report = dry_run_legacy_source(&trusted, &scope).unwrap();

    let mut db = Database::open(&database_path).unwrap();
    let applied = db.apply_legacy_report(&report, "rehearsal-apply").unwrap();
    let replayed = db.apply_legacy_report(&report, "rehearsal-apply").unwrap();
    assert!(!applied.replayed);
    assert!(replayed.replayed);
    assert_eq!(replayed.run_id, applied.run_id);
    assert_eq!(replayed.counts, applied.counts);

    let backup_counts = db.backup_to(&backup_path).unwrap();
    assert_eq!(backup_counts, applied.counts);
    let migration_error = apply_migration(
        &mut db.connection,
        99,
        "CREATE TABLE rehearsal_should_rollback (id INTEGER); THIS IS INVALID SQL;",
    )
    .unwrap_err();
    assert_eq!(migration_error.code(), "storage_error");
    assert_eq!(validate_database(&db.connection).unwrap(), applied.counts);
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'rehearsal_should_rollback'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        db.connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 99",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(db);

    let restored = Database::restore_from(&database_path, &backup_path).unwrap();
    assert_eq!(restored.counts, applied.counts);
    let restored_db = Database::open(&database_path).unwrap();
    assert_eq!(
        validate_database(&restored_db.connection).unwrap(),
        applied.counts
    );
    assert_eq!(applied.counts.work_nodes, 34);
    assert_eq!(applied.counts.projects, 5);
    assert_eq!(applied.counts.tasks, 25);
    assert_eq!(applied.counts.backlog_items, 3);
    assert_eq!(applied.counts.resource_bindings, 39);
    assert_eq!(applied.counts.progress_events, 157);
    assert_eq!(applied.counts.today_items, 0);
    let integrity = restored_db.integrity_report().unwrap();
    assert_eq!(integrity.integrity, "ok");
    assert_eq!(integrity.foreign_key_violations, 0);
    assert_eq!(integrity.invariant_violations, 0);
    assert_eq!(
        restored_db
            .connection
            .query_row("SELECT COUNT(*) FROM import_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

fn write_frozen_legacy_fixture(root: &std::path::Path) -> LegacyDryRunScope {
    std::fs::create_dir_all(root.join("registry")).unwrap();
    let mut tasks = String::from("projects:\n");
    let mut contexts = Vec::new();
    for project in 0..5 {
        writeln!(tasks, "  - slug: project-{project}").unwrap();
        let context = format!("projects/project-{project}/context");
        std::fs::create_dir_all(root.join(&context)).unwrap();
        contexts.push(context);
    }
    tasks.push_str("tasks:\n");
    let mut manifests = Vec::new();
    let mut logs = Vec::new();
    for index in 0_usize..13 {
        let id = format!("10000000-0000-0000-0000-{index:012}");
        let source_index = index.saturating_sub(1);
        let manifest = format!("tasks/source-{source_index}/.workbench/task.yaml");
        let log = format!("logs/source-{source_index}/agent_log.md");
        writeln!(tasks, "  - id: {id}").unwrap();
        writeln!(tasks, "    project_slug: project-{}", index.min(4)).unwrap();
        if index >= 5 {
            tasks.push_str("    parent_id: 10000000-0000-0000-0000-000000000000\n");
        }
        writeln!(tasks, "    key: task-{index}").unwrap();
        writeln!(tasks, "    title: Task {index}").unwrap();
        writeln!(
            tasks,
            "    status: {}",
            if index == 0 { "cancelled" } else { "planned" }
        )
        .unwrap();
        if index < 12 {
            writeln!(tasks, "    next_action: Next action {index}").unwrap();
        }
        writeln!(tasks, "    workspace: workspaces/source-{source_index}").unwrap();
        writeln!(tasks, "    manifest: {manifest}").unwrap();
        writeln!(tasks, "    agent_log: {log}").unwrap();
        tasks.push_str("    cursor: 0\n    today: false\n");

        if index > 0 {
            std::fs::create_dir_all(root.join(format!("tasks/source-{source_index}/.workbench")))
                .unwrap();
            std::fs::write(root.join(&manifest), format!("id: {id}\n")).unwrap();
            manifests.push(manifest);

            std::fs::create_dir_all(root.join(format!("logs/source-{source_index}"))).unwrap();
            let section_count = if source_index == 0 { 14 } else { 13 };
            let mut contents = String::from("# Agent log\n");
            for section in 0..section_count {
                writeln!(
                    contents,
                    "\n## Step {section}\nCompleted {source_index}:{section}"
                )
                .unwrap();
            }
            std::fs::write(root.join(&log), contents).unwrap();
            logs.push(log);
        }
    }
    std::fs::write(root.join("registry/tasks.yaml"), tasks).unwrap();
    std::fs::write(
        root.join("registry/backlog.yaml"),
        r#"items:
  - id: 30000000-0000-0000-0000-000000000000
    project_slug: project-0
    key: backlog-0
  - id: 30000000-0000-0000-0000-000000000001
    project_slug: project-1
    key: backlog-1
  - id: 30000000-0000-0000-0000-000000000002
    project_slug: project-2
    key: backlog-2
"#,
    )
    .unwrap();
    LegacyDryRunScope {
        tasks_registry: "registry/tasks.yaml".into(),
        backlog_registry: "registry/backlog.yaml".into(),
        task_manifests: manifests,
        agent_logs: logs,
        project_contexts: contexts,
    }
}

#[test]
fn context_path_comes_only_from_the_nearest_project_ancestor() {
    let mut db = Database::open_in_memory().unwrap();
    let nested_project_id = "10000000-0000-0000-0000-000000000002";
    db.create_project(
        NewProject {
            id: PROJECT_ID,
            parent_id: SYSTEM_ROOT_ID,
            key: "outer",
            title: "Outer",
            position: 0,
            slug: None,
            context_path: Some("/path/that/does/not/need/to/exist/outer"),
        },
        metadata("context-create-outer"),
    )
    .unwrap();
    db.create_project(
        NewProject {
            id: nested_project_id,
            parent_id: PROJECT_ID,
            key: "inner",
            title: "Inner",
            position: 0,
            slug: None,
            context_path: Some("/path/that/does/not/need/to/exist/inner"),
        },
        metadata("context-create-inner"),
    )
    .unwrap();
    create(
        &mut db,
        node(TASK_ID, NodeKind::Task, nested_project_id, "task", 0),
    )
    .unwrap();
    create(
        &mut db,
        node(CHILD_TASK_ID, NodeKind::Task, TASK_ID, "child", 0),
    )
    .unwrap();
    let independent_task_id = "20000000-0000-0000-0000-000000000003";
    create(
        &mut db,
        node(
            independent_task_id,
            NodeKind::Task,
            SYSTEM_ROOT_ID,
            "independent",
            1,
        ),
    )
    .unwrap();

    assert_eq!(
        db.project_context_path(PROJECT_ID).unwrap().as_deref(),
        Some("/path/that/does/not/need/to/exist/outer")
    );
    assert_eq!(
        db.project_context_path(CHILD_TASK_ID).unwrap().as_deref(),
        Some("/path/that/does/not/need/to/exist/inner")
    );
    assert_eq!(db.project_context_path(independent_task_id).unwrap(), None);
}

#[test]
fn all_current_fields_update_atomically_with_progress_events() {
    let mut db = Database::open_in_memory().unwrap();
    db.create_project(
        NewProject {
            id: PROJECT_ID,
            parent_id: SYSTEM_ROOT_ID,
            key: "project",
            title: "Initial",
            position: 0,
            slug: None,
            context_path: None,
        },
        metadata("create-project-for-patch"),
    )
    .unwrap();

    db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            title: Some("Updated"),
            summary: TextChange::Set("Summary"),
            goal: TextChange::Set("Goal"),
            acceptance: TextChange::Set("Acceptance"),
            ..WorkItemPatch::default()
        },
        1,
        "41000000-0000-0000-0000-000000000001",
        metadata("patch-content"),
    )
    .unwrap();
    db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            priority: Some(Priority::High),
            ..WorkItemPatch::default()
        },
        2,
        "41000000-0000-0000-0000-000000000002",
        metadata("patch-priority"),
    )
    .unwrap();
    db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            status: Some(WorkStatus::Pending),
            blocker: TextChange::Set("Waiting for review"),
            ..WorkItemPatch::default()
        },
        3,
        "41000000-0000-0000-0000-000000000003",
        metadata("patch-status-blocker"),
    )
    .unwrap();

    let project = db.get_project(PROJECT_ID).unwrap();
    assert_eq!(project.title, "Updated");
    assert_eq!(project.summary.as_deref(), Some("Summary"));
    assert_eq!(project.goal.as_deref(), Some("Goal"));
    assert_eq!(project.acceptance.as_deref(), Some("Acceptance"));
    assert_eq!(project.status, "pending");
    assert_eq!(project.priority, "high");
    assert_eq!(project.blocker.as_deref(), Some("Waiting for review"));
    assert_eq!(project.revision, 4);
    assert_eq!(db.progress_event_count(PROJECT_ID).unwrap(), 3);

    let failed = db.update_work_item(
        PROJECT_ID,
        WorkItemPatch {
            title: Some("Must roll back"),
            ..WorkItemPatch::default()
        },
        4,
        "41000000-0000-0000-0000-000000000003",
        metadata("patch-duplicate-event"),
    );
    assert!(failed.is_err());
    let unchanged = db.get_project(PROJECT_ID).unwrap();
    assert_eq!(unchanged.title, "Updated");
    assert_eq!(unchanged.revision, 4);
    assert_eq!(db.progress_event_count(PROJECT_ID).unwrap(), 3);
}

#[test]
fn shared_application_contract_drives_the_core_without_adapter_rules() {
    use crate::application::{
        Application, Command, CommandResult, CreateProjectCommand, CreateTaskCommand, Query,
        QueryResult, TextUpdate, UpdateWorkItemCommand,
    };

    let mut application = Application::new(Database::open_in_memory().unwrap());
    application
        .execute(Command::CreateProject(CreateProjectCommand {
            id: PROJECT_ID.into(),
            parent_id: SYSTEM_ROOT_ID.into(),
            key: "project".into(),
            title: "Project".into(),
            summary: Some("Project description".into()),
            position: 0,
            slug: None,
            context_path: Some("/work/project".into()),
            context: contract_context("contract-create-project"),
        }))
        .unwrap();
    application
        .execute(Command::CreateTask(CreateTaskCommand {
            id: TASK_ID.into(),
            parent_id: PROJECT_ID.into(),
            key: "task".into(),
            title: "Task".into(),
            summary: Some("Task description".into()),
            position: 0,
            context: contract_context("contract-create-task"),
        }))
        .unwrap();
    let contract_error = application
        .execute(Command::CreateTask(CreateTaskCommand {
            id: CHILD_TASK_ID.into(),
            parent_id: TASK_ID.into(),
            key: "different".into(),
            title: "Different request".into(),
            summary: None,
            position: 0,
            context: contract_context("contract-create-task"),
        }))
        .unwrap_err();
    assert_eq!(contract_error.code(), "idempotency_conflict");
    let updated = application
        .execute(Command::UpdateWorkItem(UpdateWorkItemCommand {
            node_id: TASK_ID.into(),
            title: None,
            summary: Some(TextUpdate::Set("Shared contract".into())),
            goal: None,
            acceptance: None,
            status: Some(WorkStatus::InProgress),
            priority: Some(Priority::High),
            blocker: Some(TextUpdate::Set("Waiting".into())),
            expected_revision: 1,
            event_id: "45000000-0000-0000-0000-000000000001".into(),
            context: contract_context("contract-update-task"),
        }))
        .unwrap();
    assert!(matches!(
        updated,
        CommandResult::Mutation(MutationResult {
            revision: 2,
            replayed: false
        })
    ));

    let task = application
        .query(Query::GetTask { id: TASK_ID.into() })
        .unwrap();
    match task {
        QueryResult::Task(task) => {
            assert_eq!(task.summary.as_deref(), Some("Shared contract"));
            assert_eq!(task.status, "in_progress");
            assert_eq!(task.priority, "high");
        }
        other => panic!("unexpected query result: {other:?}"),
    }
    match application
        .query(Query::GetProject {
            id: PROJECT_ID.into(),
        })
        .unwrap()
    {
        QueryResult::Project(project) => {
            assert_eq!(project.summary.as_deref(), Some("Project description"));
            assert_eq!(project.context_path.as_deref(), Some("/work/project"));
        }
        other => panic!("unexpected query result: {other:?}"),
    }
    assert_eq!(
        serde_json::to_value(Query::ListToday).unwrap(),
        serde_json::json!({ "type": "list_today" })
    );
}

#[test]
fn resource_binding_application_contract_creates_lists_and_updates_availability() {
    use crate::application::{
        AddResourceBindingCommand, Application, Command, CommandResult, CreateTaskCommand, Query,
        QueryResult, UpdateResourceAvailabilityCommand,
    };

    let binding_id = "50000000-0000-0000-0000-000000000001";
    let mut application = Application::new(Database::open_in_memory().unwrap());
    application
        .execute(Command::CreateTask(CreateTaskCommand {
            id: TASK_ID.into(),
            parent_id: SYSTEM_ROOT_ID.into(),
            key: "binding-task".into(),
            title: "Binding task".into(),
            summary: None,
            position: 0,
            context: contract_context("contract-create-binding-task"),
        }))
        .unwrap();

    let add = Command::AddResourceBinding(AddResourceBindingCommand {
        id: binding_id.into(),
        node_id: TASK_ID.into(),
        kind: ResourceKind::Workspace,
        locator: "/work/task".into(),
        is_primary: true,
        availability: ResourceAvailability::Available,
        source: "custodian_manifest".into(),
        context: contract_context("contract-add-binding"),
    });
    assert_eq!(
        application.execute(add.clone()).unwrap(),
        CommandResult::Mutation(MutationResult {
            revision: 1,
            replayed: false,
        })
    );
    assert_eq!(
        application.execute(add).unwrap(),
        CommandResult::Mutation(MutationResult {
            revision: 1,
            replayed: true,
        })
    );

    let update = Command::UpdateResourceAvailability(UpdateResourceAvailabilityCommand {
        binding_id: binding_id.into(),
        availability: ResourceAvailability::Missing,
        expected_revision: 1,
        context: contract_context("contract-update-binding"),
    });
    assert_eq!(
        application.execute(update.clone()).unwrap(),
        CommandResult::Mutation(MutationResult {
            revision: 2,
            replayed: false,
        })
    );
    assert_eq!(
        application.execute(update).unwrap(),
        CommandResult::Mutation(MutationResult {
            revision: 2,
            replayed: true,
        })
    );

    let QueryResult::ResourceBindings(bindings) = application
        .query(Query::ListResourceBindings {
            node_id: TASK_ID.into(),
        })
        .unwrap()
    else {
        panic!("unexpected query result");
    };
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, binding_id);
    assert_eq!(bindings[0].kind, "workspace");
    assert_eq!(bindings[0].locator, "/work/task");
    assert_eq!(bindings[0].availability, "missing");
    assert_eq!(bindings[0].revision, 2);

    let conflict = application
        .execute(Command::UpdateResourceAvailability(
            UpdateResourceAvailabilityCommand {
                binding_id: binding_id.into(),
                availability: ResourceAvailability::Unreadable,
                expected_revision: 1,
                context: contract_context("contract-stale-binding-update"),
            },
        ))
        .unwrap_err();
    assert_eq!(conflict.code(), "revision_conflict");
}

#[test]
fn backlog_application_contract_exposes_query_edit_discard_reorder_and_promotion() {
    use crate::application::{
        Application, BacklogPromotionTarget, Command, CommandResult, DiscardBacklogCommand,
        MoveBacklogCommand, PromoteBacklogCommand, Query, QueryResult, ReorderNodeCommand,
        TextUpdate, UpdateBacklogCommand,
    };

    let second_backlog_id = "30000000-0000-0000-0000-000000000002";
    let promoted_task_id = "20000000-0000-0000-0000-000000000009";
    let mut database = Database::open_in_memory().unwrap();
    create(
        &mut database,
        node(PROJECT_ID, NodeKind::Project, SYSTEM_ROOT_ID, "project", 0),
    )
    .unwrap();
    create(
        &mut database,
        node(BACKLOG_ID, NodeKind::Backlog, PROJECT_ID, "first", 0),
    )
    .unwrap();
    create(
        &mut database,
        node(
            second_backlog_id,
            NodeKind::Backlog,
            PROJECT_ID,
            "second",
            1,
        ),
    )
    .unwrap();
    let mut application = Application::new(database);

    application
        .execute(Command::UpdateBacklog(UpdateBacklogCommand {
            node_id: BACKLOG_ID.into(),
            title: Some("Edited".into()),
            notes: Some(TextUpdate::Set("Notes".into())),
            kind: Some(BacklogKind::Research),
            priority: Some(Priority::High),
            tags: Some(vec!["rust".into(), "desktop".into()]),
            expected_revision: 1,
            context: contract_context("contract-edit-backlog"),
        }))
        .unwrap();
    application
        .execute(Command::ReorderNode(ReorderNodeCommand {
            node_id: second_backlog_id.into(),
            target_position: 0,
            expected_revision: 1,
            context: contract_context("contract-reorder-backlog"),
        }))
        .unwrap();
    application
        .execute(Command::MoveBacklog(MoveBacklogCommand {
            node_id: BACKLOG_ID.into(),
            parent_id: SYSTEM_ROOT_ID.into(),
            target_position: None,
            expected_revision: 3,
            context: contract_context("contract-move-backlog"),
        }))
        .unwrap();
    application
        .execute(Command::DiscardBacklog(DiscardBacklogCommand {
            node_id: BACKLOG_ID.into(),
            expected_revision: 4,
            context: contract_context("contract-discard-backlog"),
        }))
        .unwrap();
    let promoted = application
        .execute(Command::PromoteBacklog(PromoteBacklogCommand {
            backlog_id: second_backlog_id.into(),
            target: BacklogPromotionTarget::Task {
                id: promoted_task_id.into(),
                parent_id: PROJECT_ID.into(),
                key: "promoted-task".into(),
                title: "Promoted task".into(),
                position: None,
            },
            expected_revision: 2,
            context: contract_context("contract-promote-backlog"),
        }))
        .unwrap();
    assert!(matches!(promoted, CommandResult::Promotion(_)));

    let QueryResult::Backlog(items) = application
        .query(Query::ListBacklog {
            filter: BacklogFilter {
                status: Some(BacklogStatus::Promoted),
                ..BacklogFilter::default()
            },
        })
        .unwrap()
    else {
        panic!("unexpected Backlog query result");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, second_backlog_id);
    assert_eq!(items[0].promoted_node_id.as_deref(), Some(promoted_task_id));
}

fn contract_context(idempotency_key: &str) -> crate::application::CommandContext {
    crate::application::CommandContext {
        idempotency_key: idempotency_key.into(),
        actor_type: ActorType::Custodian,
        actor_ref: Some("custodian".into()),
        channel: Channel::Mcp,
    }
}
