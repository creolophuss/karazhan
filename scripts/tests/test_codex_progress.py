import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import codex_progress as progress


class Session:
    def __init__(self, workspace, thread):
        self.metadata = dict(id=thread, cwd=str(workspace), source="cli", parentThreadId=None)
        self.turns = []
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        assert params["threadId"] == self.metadata["id"]
        if method == "thread/read":
            return {"thread": self.metadata}
        assert method == "thread/turns/list" and params["sortDirection"] == "desc"
        start = int(params.get("cursor") or 0)
        stop = start + params["limit"]
        data = self.turns[::-1][start:stop]
        if params["itemsView"] == "notLoaded":
            data = [dict(turn, items=[]) for turn in data]
        return {"data": data, "nextCursor": str(stop) if stop < len(self.turns) else None}

    def turn(self, *items, status="completed"):
        turn = dict(id=str(uuid.uuid4()), status=status, items=list(items))
        self.turns.append(turn)
        return turn


def message(text, role="assistant"):
    item_id = str(uuid.uuid4())
    if role == "user":
        return dict(id=item_id, type="userMessage", content=[dict(type="text", text=text)])
    return dict(id=item_id, type="agentMessage", phase="final_answer", text=text)


class Karazhan:
    def __init__(self):
        self.events = {}
        self.commands = []
        self.queries = []
        self.revision = 6

    def query(self, request):
        self.queries.append(request["type"])
        if request["type"] in ("get_project", "get_task"):
            return {"id": request["id"], "revision": self.revision}
        return list(self.events.values()) if request["type"] == "progress_timeline" else []

    def append(self, payload):
        self.commands.append(payload)
        self.events[payload["event_id"]] = dict(
            id=payload["event_id"], subject_node_id=payload["node_id"], event_type=payload["event_kind"],
            summary=payload["summary"], details=None, step_status=None,
            **{k: payload["context"][k] for k in ("actor_type", "actor_ref", "channel")})


class ProgressTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work = str(uuid.uuid4())
        self.thread = str(uuid.uuid4())
        (self.root / ".workbench").mkdir()
        (self.root / ".workbench/task.yaml").write_text(
            f'work:\n  id: "{self.work}"\n  kind: "project"\nworkspace:\n  path: "{self.root}"\n')
        self.log = self.root / "agent_log.md"
        self.log.write_text("# Agent log\n")
        self.session = Session(self.root, self.thread)
        self.session.turn(message("This past delivery already has a handoff."))
        self.state = dict(work=self.work, kind="project", workspace=str(self.root), thread=self.thread,
                          cursor=progress.baseline(self.session, self.root, self.thread),
                          pending=[], recent=[])
        self.file = self.root / ".workbench/codex-progress.json"
        self.mcp = Karazhan()
        self.inputs = []

    def classify(self, messages, recent):
        self.inputs.extend(messages)
        for entry in messages:
            if "交付" in entry["text"]:
                return {"kind": "delivery", "summary": "导出功能已交付。"}
        return {"kind": "none", "summary": ""}

    def scan(self):
        progress.observe(self.file, self.state, self.session, self.classify)

    def sync(self):
        progress.synchronize(self.file, self.state, self.mcp)

    def test_tick_forks_bound_thread_and_uses_checkpoint_to_select_candidates(self):
        self.session.turn(message("Option two is the nightly export."))
        self.state.update(enabled=True, codex="/test/codex", mcp="/test/mcp", database="/test/db",
                          cursor=progress.baseline(self.session, self.root, self.thread))
        self.session.turn(message("Proceed with the second option.", "user"))

        def run(args, **kwargs):
            fork = args.index("fork")
            self.assertIn("exec", args[:fork])
            self.assertIn("--ephemeral", args)
            self.assertEqual([self.thread, "-"], args[-2:])
            self.assertIn("read-only", args)
            self.assertIn("agents.enabled=false", args)
            self.assertIn("Proceed with the second option.", kwargs["input"])
            self.assertNotIn("nightly export", kwargs["input"])
            output = Path(args[args.index("--output-last-message") + 1])
            output.write_text(json.dumps(dict(kind="progress", summary="Adopted the nightly export.")))
            return subprocess.CompletedProcess(args, 0)

        def connect(command, database=None):
            return nullcontext(self.mcp if database else self.session)

        with patch.object(progress, "connection", side_effect=connect), patch.object(subprocess, "run", side_effect=run) as cli:
            progress.tick(self.file, self.state)
            progress.tick(self.file, self.state)
        self.assertEqual(1, cli.call_count)
        self.assertEqual(["Adopted the nightly export."], [p["summary"] for p in self.mcp.commands])

    def test_fork_failure_retains_unprocessed_messages(self):
        self.state.update(enabled=True, codex="/test/codex")
        initial = self.state["cursor"].copy()
        self.session.turn(message("Proceed with the second option."))
        with patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as cli:
            with self.assertRaisesRegex(RuntimeError, "fork"):
                progress.tick(self.file, self.state)
        self.assertIn("fork", cli.call_args.args[0])
        self.assertEqual(1, cli.call_count)
        self.assertEqual(initial, self.state["cursor"])
        self.assertFalse(self.state["pending"])
        self.assertEqual("# Agent log\n", self.log.read_text())

    def test_history_idle_routine_and_visible_messages_in_active_turn(self):
        self.scan()
        self.assertEqual([], self.inputs)
        turn = self.session.turn(message("我先看代码。", "user"),
                                 dict(type="commandExecution", id="tool", aggregatedOutput="TOOL_PRIVATE"),
                                 dict(type="reasoning", id="reason", content=["PRIVATE_THOUGHT"]),
                                 status="inProgress")
        self.scan()
        self.assertEqual("# Agent log\n", self.log.read_text())
        turn["items"].append(message("导出功能已交付。"))
        self.scan()
        self.assertIn("导出功能已交付。", self.log.read_text())
        self.assertEqual(1, len(self.state["pending"]))
        self.sync()
        turn["status"] = "completed"
        self.scan()
        self.sync()
        self.assertEqual(1, len(self.mcp.commands))
        self.assertEqual(["我先看代码。", "导出功能已交付。"], [m["text"] for m in self.inputs])
        self.assertIn("progress_timeline", self.mcp.queries)
        self.assertFalse(self.state["pending"])

    def test_lost_reply_verifies_original_event_without_duplicate(self):
        self.session.turn(message("导出功能已交付。"))
        self.scan()
        append = self.mcp.append
        def lose_reply(payload):
            self.assertIn(payload["event_id"], self.log.read_text())
            self.assertIn('"expected_revision":6', self.log.read_text())
            append(payload)
            raise RuntimeError("lost reply")
        with patch.object(self.mcp, "append", lose_reply), self.assertRaises(RuntimeError):
            self.sync()
        self.state = json.loads(self.file.read_text())
        self.mcp.revision += 1
        self.sync()
        self.assertEqual(1, len(self.mcp.commands))
        self.assertEqual(6, self.mcp.commands[0]["expected_revision"])
        self.assertFalse(self.state["pending"])

    def test_subagent_wrong_workspace_and_missing_cursor(self):
        self.session.metadata["parentThreadId"] = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            self.scan()
        self.session.metadata.update(parentThreadId=None, source={"subAgent": "review"})
        with self.assertRaises(ValueError):
            self.scan()
        self.session.metadata.update(source="cli", cwd=self.temp.name + "/elsewhere")
        with self.assertRaises((OSError, ValueError)):
            self.scan()
        self.session.metadata.update(cwd=str(self.root))
        self.session.turns.clear()
        with self.assertRaises(ValueError):
            self.scan()
        self.assertFalse(self.inputs)

    def test_private_material_pagination_and_revised_active_message(self):
        for i in range(7):
            self.session.turn(message(f"Routine note {i}."))
        turn = self.session.turn(message("API_KEY=synthetic-test-value", "user"),
                                 message("Reviewing.\n```\nSYNTHETIC_CODE\n```"),
                                 status="inProgress")
        self.scan()
        self.assertEqual([f"Routine note {i}." for i in range(7)] + ["Reviewing."],
                         [m["text"] for m in self.inputs])
        turn["items"][-1]["text"] = "导出功能已交付。"
        self.scan()
        self.assertEqual(1, len(self.state["pending"]))
        for text in [self.file.read_text(), self.log.read_text()]:
            self.assertNotIn("SYNTHETIC_CODE", text)
            self.assertNotIn("synthetic-test-value", text)

    def test_sensitive_output_fails_before_advancing_checkpoint(self):
        self.session.turn(message("Deliverable ready for review."))
        previous = self.state["cursor"].copy()
        with self.assertRaises(ValueError):
            progress.observe(self.file, self.state, self.session,
                             lambda *_: dict(kind="delivery", summary="token: synthetic-test-value"))
        self.assertEqual(previous, self.state["cursor"])
        self.assertEqual("# Agent log\n", self.log.read_text())

    def test_local_only_turn_does_not_send_the_assistant_reply(self):
        turn = self.session.turn(message("Routine."), status="inProgress")
        self.scan()
        turn["items"] += [message("请勿同步本轮内容。", "user"), message("导出功能已交付。")]
        self.scan()
        self.assertFalse(self.state["pending"])
        self.assertEqual(["Routine."], [m["text"] for m in self.inputs])
        self.assertEqual("# Agent log\n", self.log.read_text())

    def test_newer_turn_cannot_hide_late_messages_from_an_open_turn(self):
        first = self.session.turn(message("Starting."), status="inProgress")
        self.session.turn(message("Other note."))
        self.scan()
        first["items"].append(message("导出功能已交付。"))
        first["status"] = "completed"
        self.scan()
        self.assertEqual(["Starting.", "导出功能已交付。", "Other note."], [m["text"] for m in self.inputs])
        self.assertEqual(1, len(self.state["pending"]))

    def test_outage_before_revision_and_later_local_changes(self):
        self.session.turn(message("导出功能已交付。"))
        self.scan()
        with patch.object(self.mcp, "query", side_effect=RuntimeError("offline")), self.assertRaises(RuntimeError):
            self.sync()
        self.assertIn("导出功能已交付。", self.log.read_text())
        self.session.turn(message("The release is blocked pending approval."))
        progress.observe(self.file, self.state, self.session,
                         lambda *_: dict(kind="progress", summary="Release blocked pending approval."))
        self.assertIn("Release blocked pending approval.", self.log.read_text())
        self.state = json.loads(self.file.read_text())
        self.sync()
        self.assertEqual(["delivery", "progress"], [p["event_kind"] for p in self.mcp.commands])
        self.assertEqual(2, self.log.read_text().count(" observed -->"))
        self.assertEqual(2, self.log.read_text().count(" verified -->"))

    def test_uncertain_absent_event_reuses_original_request_and_revision(self):
        self.session.turn(message("导出功能已交付。"))
        self.scan()
        with patch.object(self.mcp, "append", side_effect=RuntimeError("lost")) as attempt, self.assertRaises(RuntimeError):
            self.sync()
        original = attempt.call_args.args[0]
        self.mcp.revision += 1
        self.state = json.loads(self.file.read_text())
        self.sync()
        self.assertEqual(original, self.mcp.commands[0])

    def test_revision_conflict_keeps_both_requests_and_same_event(self):
        self.session.turn(message("导出功能已交付。"))
        self.scan()
        with patch.object(self.mcp, "append", side_effect=progress.RpcError("append", "revision_conflict")) as attempt:
            with self.assertRaises(progress.RpcError):
                self.sync()
        first = attempt.call_args.args[0]
        self.mcp.revision += 1
        self.sync()
        second = self.mcp.commands[0]
        self.assertEqual(first["event_id"], second["event_id"])
        self.assertNotEqual(first["context"]["idempotency_key"], second["context"]["idempotency_key"])
        self.assertIn('"expected_revision":6', self.log.read_text())
        self.assertIn('"expected_revision":7', self.log.read_text())

    def test_acknowledged_event_only_retries_verification(self):
        self.session.turn(message("导出功能已交付。"))
        self.scan()
        query = self.mcp.query
        with patch.object(self.mcp, "query", side_effect=lambda req: query(req) if req["type"] == "get_project" else []):
            with self.assertRaisesRegex(RuntimeError, "verification pending"):
                self.sync()
            with self.assertRaisesRegex(RuntimeError, "verification pending"):
                self.sync()
        self.state = json.loads(self.file.read_text())
        self.sync()
        self.assertEqual(1, len(self.mcp.commands))
        self.assertFalse(self.state["pending"])

    def test_workspace_identity_lock_and_local_log_boundary(self):
        self.assertEqual((self.work, "project"), progress.identity(self.root))
        with progress.workspace_lock(self.file):
            with self.assertRaises(BlockingIOError), progress.workspace_lock(self.file):
                self.fail("overlapping timer")
        self.log.rename(self.root / "original")
        self.log.symlink_to(self.root / "original")
        self.session.turn(message("导出功能已交付。"))
        with self.assertRaises(OSError):
            self.scan()
        with self.assertRaises(OSError):
            self.sync()
        self.assertEqual("# Agent log\n", (self.root / "original").read_text())
        self.assertFalse(self.mcp.commands)

    def test_launch_agent_install_retry_and_disable(self):
        self.state.update(interval=300, codex_home=str(self.root / "codex"),
                          python=sys.executable, script=str(Path(progress.__file__).resolve()))
        loaded = False
        def launchctl(args, **kwargs):
            nonlocal loaded
            if args[1] == "print":
                return subprocess.CompletedProcess(args, 0 if loaded else 113)
            loaded = args[1] == "bootstrap"
            return subprocess.CompletedProcess(args, 0)
        with patch.object(Path, "home", return_value=self.root), patch.object(subprocess, "run", side_effect=launchctl) as run:
            progress.schedule(self.state, True)
            progress.schedule(self.state, True)
            plist, = (self.root / "Library/LaunchAgents").glob("*.plist")
            job = plistlib.loads(plist.read_bytes())
            self.assertEqual(300, job["StartInterval"])
            self.assertEqual(["run", "--workspace", str(self.root)], job["ProgramArguments"][-3:])
            self.assertEqual({"CODEX_HOME": str(self.root / "codex")}, job["EnvironmentVariables"])
            self.assertEqual(1, sum(c.args[0][1] == "bootstrap" for c in run.call_args_list))
            progress.schedule(self.state, False)
            self.assertFalse(loaded or plist.exists())

    def test_enable_pins_thread_starts_at_end_and_preserves_active_checkpoint(self):
        database = self.root / "synthetic.db"
        database.touch()
        args = SimpleNamespace(thread=self.thread, database=str(database), interval=300)
        state = {}
        with patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), patch.object(progress, "schedule"):
            def enable():
                progress.enable(self.file, self.root, self.work, "project", state, args)
            enable()
            initial = state["cursor"]
            self.session.turn(message("导出功能已交付。"))
            enable()
            self.assertEqual(initial, state["cursor"])
            args.thread = str(uuid.uuid4())
            with self.assertRaisesRegex(ValueError, "Disable"):
                enable()
            state.update(enabled=False, auto_start=False)
            args.thread = self.thread
            enable()
            self.assertNotEqual(initial, state["cursor"])
            self.assertEqual(self.session.turns[-1]["id"], state["cursor"]["turn"])

    def test_interval_from_cli_defaults_to_one_hour_and_preserves_active_schedules(self):
        db = self.root / "synthetic.db"
        db.touch()
        args = ["codex_progress.py", "enable", "--thread", self.thread, "--database", str(db),
                "--workspace", str(self.root)]
        with patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), \
             patch.object(progress, "schedule"), patch("builtins.print"):
            for seconds in (3600, 7200, 300):
                with self.subTest(seconds=seconds):
                    self.file.unlink(missing_ok=True)
                    explicit = [] if seconds == 3600 else ["--interval", str(seconds)]
                    with patch.object(sys, "argv", args + explicit):
                        progress.main()
                    state = json.loads(self.file.read_text())
                    self.assertEqual(seconds, progress.launch_job(state)["StartInterval"])
                    with patch.object(sys, "argv", args):
                        progress.main()
                    self.assertEqual(state, json.loads(self.file.read_text()))

    def command(self, *args, event=None):
        output = io.StringIO()
        with patch.object(sys, "argv", ["codex_progress.py", *args, "--workspace", str(self.root)]), \
             patch.object(sys, "platform", "darwin"), \
             patch.object(sys, "stdin", io.StringIO(json.dumps(event))), patch.object(sys, "stdout", output):
            progress.main()
        return json.loads(output.getvalue()) if output.getvalue() else None

    def test_default_starts_from_hook_and_preserves_existing_binding(self):
        self.assertTrue(self.command("status")["auto_start"])
        self.assertFalse(self.file.exists())
        event = dict(hook_event_name="SessionStart", source="resume", session_id=self.thread, cwd=str(self.root))
        db = self.root / "test.sqlite"
        db.touch()
        with patch.dict(os.environ, {"KARAZHAN_DATABASE_PATH": str(db), "CODEX_THREAD_ID": str(uuid.uuid4())}), \
             patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), patch.object(progress, "schedule") as scheduler:
            output = self.command("startup", "--hook", event=event)
            self.assertIn("timer owns ordinary progress", output["hookSpecificOutput"]["additionalContext"])
            initial = json.loads(self.file.read_text())
            self.assertTrue(initial["enabled"])
            self.assertEqual((self.thread, 3600), (initial["thread"], initial["interval"]))
            self.session.turn(message("new activity"))
            self.command("startup", "--hook", event=event)
            self.command("startup", "--hook", event=dict(event, session_id=str(uuid.uuid4())))
            self.assertEqual(initial, json.loads(self.file.read_text()))
            self.assertTrue(scheduler.called)
            self.command("disable")
            scheduler.reset_mock()
            self.command("startup", "--hook", event=event)
            self.assertFalse(self.command("status")["auto_start"])
            scheduler.assert_not_called()

    def test_disable_before_start_and_legacy_opt_out(self):
        self.command("disable")
        self.assertFalse(self.command("status")["auto_start"])
        with patch.object(progress, "connection") as session, patch.object(progress, "schedule") as scheduler:
            self.command("startup")
            progress.save(self.file, dict(self.state, enabled=False))
            self.command("startup")
            session.assert_not_called()
            scheduler.assert_not_called()
            self.assertFalse(self.command("status")["auto_start"])
        db = self.root / "test.sqlite"
        db.touch()
        with patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), patch.object(progress, "schedule"):
            self.command("enable", "--thread", self.thread, "--database", str(db))
        self.assertTrue(self.command("status")["auto_start"])

    def test_late_enrollment_observes_first_completed_turn_and_skips_forks(self):
        db = self.root / "test.sqlite"
        db.touch()
        earlier = self.session.turns[-1]["id"]
        latest = self.session.turn(message("Delivered the export"))
        event = dict(hook_event_name="Stop", session_id=self.thread, turn_id=latest["id"], cwd=str(self.root))
        with patch.dict(os.environ, {"KARAZHAN_DATABASE_PATH": str(db)}), \
             patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), patch.object(progress, "schedule") as scheduler:
            self.session.metadata["forkedFromId"] = str(uuid.uuid4())
            self.command("startup", "--hook", event=event)
            self.assertFalse(self.file.exists())
            scheduler.assert_not_called()
            self.session.metadata["forkedFromId"] = None
            self.command("startup", "--hook", event=event)
            self.assertEqual(earlier, json.loads(self.file.read_text())["cursor"]["turn"])

    def test_hook_install_is_local_idempotent_and_keeps_other_handlers(self):
        hooks = self.root / ".codex/hooks.json"
        hooks.parent.mkdir()
        original = {"matcher": "resume", "hooks": [{"type": "command", "command": "existing"}]}
        hooks.write_text(json.dumps({"hooks": {"SessionStart": [original]}, "description": "Keep"}))
        self.command("install-hook")
        first = hooks.read_bytes()
        self.command("install-hook")
        self.assertEqual(first, hooks.read_bytes())
        config = json.loads(first)
        self.assertEqual("Keep", config["description"])
        self.assertEqual(original, config["hooks"]["SessionStart"][0])
        self.assertEqual(2, len(config["hooks"]["SessionStart"]))
        self.assertEqual(1, len(config["hooks"]["Stop"]))
        self.assertFalse(self.file.exists())

    def test_bootstrap_failure_retries_from_saved_checkpoint(self):
        db = self.root / "test.sqlite"
        db.touch()
        event = dict(hook_event_name="SessionStart", source="resume", session_id=self.thread, cwd=str(self.root))
        with patch.dict(os.environ, {"KARAZHAN_DATABASE_PATH": str(db)}), \
             patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "executable", return_value="/test/bin"), \
             patch.object(progress, "schedule", side_effect=[OSError("launchd unavailable"), None]):
            with self.assertRaisesRegex(OSError, "launchd"):
                self.command("startup", "--hook", event=event)
            initial = json.loads(self.file.read_text())["cursor"]
            self.session.turn(message("New milestone"))
            self.command("startup", "--hook", event=event)
            state = json.loads(self.file.read_text())
            self.assertTrue(state["enabled"])
            self.assertEqual(initial, state["cursor"])
            self.assertNotIn("error", state)

    def test_discovers_configured_database_and_command_without_copying_other_environment(self):
        db = self.root / "configured.sqlite"
        db.touch()
        server = dict(enabled=True, transport=dict(type="stdio", command="/test/companion", args=[],
                      env=dict(KARAZHAN_DATABASE_PATH=str(db), UNRELATED_PRIVATE="synthetic private setting")))
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(progress, "connection", return_value=nullcontext(self.session)), \
             patch.object(progress, "schedule"), patch.object(progress, "executable", side_effect=lambda name: name), \
             patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(server))) as config:
            self.command("startup", "--thread", self.thread)
            self.assertEqual(["codex", "mcp", "get", "karazhan", "--json"], config.call_args.args[0])
            state = json.loads(self.file.read_text())
            self.assertEqual(("/test/companion", str(db)), (state["mcp"], state["database"]))
            self.assertNotIn("synthetic private setting", self.file.read_text())
            config.return_value = subprocess.CompletedProcess([], 0, json.dumps(dict(server, enabled=False)))
            with self.assertRaisesRegex(ValueError, "KARAZHAN_DATABASE_PATH"):
                progress.mcp_settings("codex", self.root, None)
