"""Run a per-Workspace macOS timer for one Codex Custodian thread."""

import argparse
import fcntl
import json
import os
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager, nullcontext
from datetime import datetime
from pathlib import Path

from codex_progress_runtime import SENSITIVE, RpcError, classify, connection, messages


def workspace_at(directory):
    path = Path(directory).resolve(strict=True)
    for root in (path, *path.parents):
        manifest = root / ".workbench/task.yaml"
        if manifest.is_file():
            if manifest.is_symlink() or manifest.parent.is_symlink():
                raise ValueError("The Workspace manifest must be local")
            return root
    raise ValueError("No Workspace manifest for this directory")


def identity(root):
    text = (root / ".workbench/task.yaml").read_text(encoding="utf-8")

    def field(section, key):
        blocks = re.findall(rf"^{section}:[ \t]*(?:#.*)?\n((?:[ \t]+[^\n]*\n?|\n)*)", text, re.M)
        values = re.findall(rf"^  {key}:[ \t]*(.+?)\s*$", blocks[0], re.M) if len(blocks) == 1 else []
        if len(values) != 1:
            raise ValueError(f"Invalid Workspace manifest {section}.{key}")
        value = values[0].split(" #", 1)[0].strip()
        return value[1:-1] if value[:1] in ("'", '"') and value[-1:] == value[:1] else value

    work, kind = str(uuid.UUID(field("work", "id"))), field("work", "kind")
    if kind not in ("project", "task") or Path(field("workspace", "path")).resolve(strict=True) != root:
        raise ValueError("Workspace manifest identity mismatch")
    return work, kind


def save(path, state, indent=None):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, encoding="utf-8", delete=False) as temp:
        try:
            json.dump(state, temp, ensure_ascii=False, indent=indent)
            if indent:
                temp.write("\n")
            temp.flush()
            os.fsync(temp.fileno())
            os.replace(temp.name, path)
        finally:
            Path(temp.name).unlink(missing_ok=True)


@contextmanager
def workspace_lock(path, wait=False):
    fd = os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class IneligibleThread(ValueError):
    pass


def verify_thread(session, root, thread):
    meta = session.call("thread/read", {"threadId": thread})["thread"]
    if (meta["id"] != thread or meta.get("source") not in ("cli", "vscode", "exec", "appServer")
            or meta.get("parentThreadId") or meta.get("forkedFromId") or meta.get("agentRole") or meta.get("ephemeral")
            or workspace_at(meta["cwd"]) != root):
        raise IneligibleThread("Select a persisted main Codex thread in this Workspace")


def page(session, thread, limit, view, cursor=None):
    return session.call("thread/turns/list", dict(threadId=thread, sortDirection="desc",
                        itemsView=view, cursor=cursor, limit=limit))


def checkpoint(turn, last=None, closed=False):
    return dict(turn=turn, item=last["id"] if last else None,
                digest=last["digest"] if last else None, closed=closed)


def baseline(session, root, thread, include_turn=None):
    verify_thread(session, root, thread)
    latest = page(session, thread, 2 if include_turn else 1, "full")["data"]
    if include_turn and latest and latest[0]["id"] == include_turn:
        latest = latest[1:]
    if not latest:
        return None
    visible = messages(latest[0]) or []
    return checkpoint(latest[0]["id"], visible[-1] if visible else None, latest[0]["status"] != "inProgress")


def changed_turns(session, thread, previous):
    latest = page(session, thread, 1, "notLoaded")["data"]
    if latest and previous and latest[0]["id"] == previous["turn"] and previous["closed"]:
        return []
    result, cursor = [], None
    while latest:
        batch = page(session, thread, 4, "full", cursor)
        for turn in batch["data"]:
            anchor = previous and turn["id"] == previous["turn"]
            if anchor and previous["closed"]:
                return reversed(result)
            visible = messages(turn)
            if visible is None:
                visible = []
            elif anchor and previous["item"]:
                ids = [message["id"] for message in visible]
                if previous["item"] not in ids:
                    raise ValueError("Codex message checkpoint is missing. Inspect the thread history.")
                index = ids.index(previous["item"])
                if visible[index]["digest"] == previous["digest"]:
                    index += 1
                visible = visible[index:]
            result.append((turn["id"], turn["status"], visible))
            if anchor:
                return reversed(result)
        cursor = batch["nextCursor"]
        if not cursor:
            break
    if previous:
        raise ValueError("Codex turn checkpoint is missing. Inspect the thread history.")
    return reversed(result)


def log_once(state, event, stage, text):
    path = Path(state["workspace"], "agent_log.md")
    marker = f"<!-- codex-progress {event['id']} {stage} -->"
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+b") as log:
        if marker.encode() in log.read():
            return
        stamp = datetime.now().astimezone().isoformat(timespec="seconds")
        log.write(f"\n- {stamp} {text} {marker}\n".encode())
        log.flush()
        os.fsync(log.fileno())


def log_fact(state, event):
    log_once(state, event, "observed", f"Codex {event['kind']} · {event['summary']}")


def observe(path, state, session, decide):
    root, thread = Path(state["workspace"]), state["thread"]
    verify_thread(session, root, thread)
    for turn, status, visible in changed_turns(session, thread, state["cursor"]):
        cursor = state["cursor"]
        last = None
        if cursor and cursor["turn"] == turn and cursor["item"]:
            last = dict(id=cursor["item"], digest=cursor["digest"])
        for start in range(0, len(visible), 8):
            batch = visible[start:start + 8]
            inputs = [dict(role=item["role"], text=item["text"]) for item in batch]
            decision = decide(inputs, state["recent"])
            kind, summary = decision["kind"], decision["summary"]
            if kind not in ("none", "progress", "delivery") or not isinstance(summary, str):
                raise ValueError("Invalid Codex classification. Checkpoint retained.")
            last = batch[-1]
            event = None
            if kind != "none":
                summary = summary.strip()
                if not 0 < len(summary) <= 300 or not summary.isprintable() or SENSITIVE.search(summary) or "<" in summary:
                    raise ValueError("Unsafe or invalid progress summary. Checkpoint retained.")
                if summary not in state["recent"][-1:]:
                    source = f"{thread}/{turn}/{last['id']}/{last['digest']}"
                    event = dict(id=str(uuid.uuid5(uuid.UUID(state["work"]), source)), kind=kind, summary=summary)
                    state["pending"].append(event)
                    state["recent"] = (state["recent"] + [summary])[-8:]
            state["cursor"] = checkpoint(turn, last)
            save(path, state)
            if event:
                log_fact(state, event)
        end = checkpoint(turn, last, status != "inProgress")
        if end != state["cursor"]:
            state["cursor"] = end
            save(path, state)
        # A later turn can appear before this turn's last message has been stored.
        if not end["closed"]:
            break


def payload_for(state, event):
    return dict(node_id=state["work"], event_id=event["id"], event_kind=event["kind"],
                summary=event["summary"], details=None, step_status=None, expected_revision=event["revision"],
                context=dict(idempotency_key=f"codex-progress:{event['id']}:{event['revision']}", actor_type="task_agent",
                             actor_ref="custodian:" + state["work"], channel="mcp"))


def verified(mcp, payload):
    expected = dict(id=payload["event_id"], subject_node_id=payload["node_id"], event_type=payload["event_kind"],
                    summary=payload["summary"], details=None, step_status=None, actor_type="task_agent",
                    actor_ref=payload["context"]["actor_ref"], channel="mcp")
    for query in (dict(type="recent_progress", limit=10), dict(type="progress_timeline")):
        events = mcp.query(dict(query, node_id=payload["node_id"]))
        matches = [event for event in events if event["id"] == expected["id"]]
        if matches:
            if len(matches) != 1 or any(matches[0].get(k) != v for k, v in expected.items()):
                raise RpcError("verify progress", "event_mismatch")
            return True
    return False


def synchronize(path, state, mcp):
    while state["pending"]:
        event = state["pending"][0]
        log_fact(state, event)
        prepared = "revision" in event
        found = prepared and verified(mcp, payload_for(state, event))
        conflict = event.get("conflict")
        if not found and conflict and conflict != "revision_conflict":
            raise RpcError("pending progress", conflict)
        if not prepared or (not found and conflict == "revision_conflict"):
            node = mcp.query(dict(type="get_" + state["kind"], id=state["work"]))
            if node["id"] != state["work"]:
                raise ValueError("Karazhan returned another Work")
            if conflict and node["revision"] == event["revision"]:
                raise RpcError("pending progress", conflict)
            event["revision"] = node["revision"]
            event.pop("conflict", None)
            save(path, state)
        payload = payload_for(state, event)
        request = dict(request=dict(type="append_progress", payload=payload))
        log_once(state, event, f"request-r{event['revision']}", json.dumps(request, ensure_ascii=False, separators=(",", ":")))
        try:
            if not found and not event.get("sent"):
                mcp.append(payload)
                event["sent"] = True
                save(path, state)
                found = verified(mcp, payload)
            if not found:
                raise RuntimeError("Karazhan verification pending")
        except RpcError as error:
            if error.code in ("revision_conflict", "idempotency_conflict", "event_mismatch"):
                event["conflict"] = error.code
                save(path, state)
                log_once(state, event, f"conflict-r{event['revision']}", f"Karazhan requires reconciliation ({error.code}).")
            raise
        log_once(state, event, "verified", "Karazhan progress verified.")
        state["pending"].pop(0)
        save(path, state)


def tick(path, state):
    if not state["enabled"]:
        return
    try:
        with connection(state["codex"]) as session:
            observe(path, state, session, lambda batch, recent: classify(state["codex"], state["thread"], batch, recent))
    finally:
        if state["pending"]:
            for event in state["pending"]:
                log_fact(state, event)
            with connection(state["mcp"], state["database"]) as mcp:
                synchronize(path, state, mcp)


def executable(name):
    resolved = shutil.which(name)
    if not resolved:
        raise ValueError(f"Executable unavailable: {name}")
    return os.path.abspath(resolved)


def launch_job(state):
    label = "com.karazhan.codex-progress." + state["work"]
    job = dict(Label=label, StartInterval=state["interval"], RunAtLoad=True,
               ProgramArguments=[state["python"], "-B", state["script"], "run",
                                 "--workspace", state["workspace"]])
    if state.get("codex_home"):
        job["EnvironmentVariables"] = {"CODEX_HOME": state["codex_home"]}
    return job


def schedule(state, enable):
    job = launch_job(state)
    plist = Path.home() / "Library/LaunchAgents" / (job["Label"] + ".plist")
    domain = f"gui/{os.getuid()}"
    service = domain + "/" + job["Label"]
    present = plist.exists()
    if present and (plist.is_symlink() or plistlib.loads(plist.read_bytes()) != job):
        raise ValueError("Existing LaunchAgent differs from the saved job")
    loaded = subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL).returncode == 0
    if loaded and not present:
        raise ValueError("Another LaunchAgent uses this Work ID")
    if enable:
        if not present:
            plist.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=plist.parent) as target:
                plistlib.dump(job, target)
                target.flush()
                os.fsync(target.fileno())
                os.link(target.name, plist)
        if not loaded:
            try:
                subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
            except (OSError, subprocess.CalledProcessError):
                if not present:
                    plist.unlink(missing_ok=True)
                raise
    else:
        if loaded:
            subprocess.run(["launchctl", "bootout", service], check=True)
        plist.unlink(missing_ok=True)


def mcp_settings(codex, root, database):
    database = database or os.environ.get("KARAZHAN_DATABASE_PATH")
    command = os.environ.get("KARAZHAN_MCP_COMMAND")
    if not database:
        result = subprocess.run([codex, "mcp", "get", "karazhan", "--json"], cwd=root,
                                capture_output=True, text=True, timeout=10)
        server = json.loads(result.stdout) if result.returncode == 0 else {}
        transport = server.get("transport") or {}
        if server.get("enabled") and transport.get("type") == "stdio":
            database = (transport.get("env") or {}).get("KARAZHAN_DATABASE_PATH")
            if not command and not transport.get("args"):
                command = transport.get("command")
    if not database or not Path(database).is_absolute() or not Path(database).is_file():
        raise ValueError("Configure an existing KARAZHAN_DATABASE_PATH for the Codex karazhan MCP server or supply --database")
    return executable(command or "karazhan-mcp"), str(Path(database).resolve())


def auto_start(state):
    # Older disabled schedules recorded the opt-out in enabled alone.
    return state.get("auto_start", state.get("enabled", True))


def enable(path, root, work, kind, state, args, include_turn=None):
    thread = str(uuid.UUID(args.thread or os.environ.get("CODEX_THREAD_ID") or ""))
    codex = executable("codex")
    interval = args.interval
    if interval is None:
        interval = state["interval"] if state.get("enabled") else 3600
    if interval <= 0:
        raise ValueError("--interval must be positive (seconds)")
    cursor = state.get("cursor")
    if not state.get("enabled") and (state.get("thread") != thread or not auto_start(state) or "cursor" not in state):
        with connection(codex) as session:
            cursor = baseline(session, root, thread, include_turn)
    mcp, database = mcp_settings(codex, root, args.database)
    config = dict(work=work, kind=kind, workspace=str(root), thread=thread, interval=interval,
                  database=database, codex=codex, python=sys.executable, script=os.path.abspath(__file__),
                  codex_home=os.environ.get("CODEX_HOME"),
                  mcp=mcp)
    if state.get("enabled") and any(state.get(k) != v for k, v in config.items()):
        raise ValueError("Disable the current schedule before changing its binding")
    if state.get("pending") and state["database"] != config["database"]:
        raise ValueError("Reconcile pending progress before changing the database")
    state.update(config)
    state.setdefault("pending", [])
    state.setdefault("recent", [])
    state.update(cursor=cursor, auto_start=True, enabled=bool(state.get("enabled")))
    save(path, state)
    schedule(state, True)
    state["enabled"] = True
    state.pop("error", None)
    save(path, state)


def install_hook(root):
    path = root / ".codex/hooks.json"
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Codex hook settings must be local to the Workspace")
    original = path.read_text(encoding="utf-8") if path.exists() else "{}"
    config = json.loads(original)
    if not isinstance(config, dict) or not isinstance(config.get("hooks", {}), dict):
        raise ValueError("Invalid Codex hook settings")
    hooks = config.setdefault("hooks", {})
    command = shlex.join(["python3", "-B", os.path.abspath(__file__), "startup", "--hook", "--workspace", str(root)])
    marker = " # karazhan-codex-progress"
    handler = dict(type="command", command=command + marker, timeout=30)
    for name in ("SessionStart", "Stop"):
        groups = []
        existing = hooks.get(name, [])
        if not isinstance(existing, list):
            raise ValueError(f"Invalid Codex {name} hook list")
        for group in existing:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError(f"Invalid Codex {name} handler group")
            keep = [h for h in group["hooks"] if not str(h.get("command", "")).endswith(marker)]
            if keep or not group["hooks"]:
                groups.append(dict(group, hooks=keep))
        entry = {"hooks": [handler]}
        if name == "SessionStart":
            entry["matcher"] = "startup|resume|clear"
        hooks[name] = groups + [entry]
    path.parent.mkdir(exist_ok=True)
    if json.loads(original) != config:
        save(path, config, indent=2)


def startup(path, root, work, kind, state, args, event):
    if not auto_start(state) or sys.platform != "darwin":
        return
    stop = event.get("hook_event_name") == "Stop"
    if args.hook:
        if not stop and (event.get("hook_event_name") != "SessionStart" or
                         event.get("source") not in ("startup", "resume", "clear")):
            return
        if event.get("agent_id") or workspace_at(event["cwd"]) != root:
            return
        args.thread = event["session_id"]
    thread = str(uuid.UUID(args.thread or os.environ.get("CODEX_THREAD_ID") or ""))
    if state.get("thread") and state["thread"] != thread:
        return
    if state.get("enabled"):
        if not stop:
            schedule(state, True)
        return True
    try:
        enable(path, root, work, kind, state, args, event.get("turn_id") if stop else None)
    except IneligibleThread:
        return
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    for action in ("enable", "disable", "run", "status", "startup", "install-hook"):
        sub = subs.add_parser(action)
        sub.add_argument("--workspace", default=".")
        if action in ("enable", "startup"):
            sub.add_argument("--thread", help="main thread UUID (default: CODEX_THREAD_ID)")
            sub.add_argument("--database", help="existing Karazhan database (default: KARAZHAN_DATABASE_PATH)")
            sub.add_argument("--interval", type=int, help="seconds between checks (new schedules default to 3600)")
        if action == "startup":
            sub.add_argument("--hook", action="store_true", help="read the native Codex event from stdin")
    args = parser.parse_args()
    root = workspace_at(args.workspace)
    work, kind = identity(root)
    path = root / ".workbench/codex-progress.json"
    hook = args.action == "startup" and args.hook
    event = json.load(sys.stdin) if hook else {}
    lock = nullcontext() if args.action == "status" else workspace_lock(path, wait=args.action != "run" and not hook)
    with lock:
        if path.is_symlink():
            raise ValueError("Workspace progress state must be local")
        state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if state and (state["work"], state["kind"], state["workspace"]) != (work, kind, str(root)):
            raise ValueError("Saved timer belongs to another Work or Workspace")
        if args.action == "install-hook":
            install_hook(root)
            return
        if args.action == "startup":
            try:
                started = startup(path, root, work, kind, state, args, event)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                state.update(work=work, kind=kind, workspace=str(root), error=str(error))
                save(path, state)
                raise
        elif args.action == "enable":
            enable(path, root, work, kind, state, args)
        elif args.action == "disable":
            if state.get("script"):
                schedule(state, False)
            state.update(work=work, kind=kind, workspace=str(root), enabled=False, auto_start=False)
            state.pop("error", None)
            save(path, state)
        elif args.action == "run" and state.get("enabled"):
            try:
                tick(path, state)
            except Exception as error:
                state["error"] = str(error)
                save(path, state)
                raise
            if state.pop("error", None):
                save(path, state)
        if hook and event.get("hook_event_name") == "Stop":
            print("{}")
        elif hook and started:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext":
                  "The Karazhan timer owns ordinary progress for this thread. Leave those agent_log.md and "
                  "Karazhan updates to the timer. Continue saving evidence and formal handoffs."}}))
        elif not hook and args.action != "run":
            print(json.dumps(dict(auto_start=auto_start(state), enabled=state.get("enabled", False),
                                  interval=state.get("interval", 3600), thread=state.get("thread"),
                                  pending=len(state.get("pending", [])), error=state.get("error"))))


if __name__ == "__main__":
    try:
        main()
    except BlockingIOError:
        if sys.argv[1:2] != ["run"] and not (sys.argv[1:2] == ["startup"] and "--hook" in sys.argv):
            sys.exit("Another progress operation holds the Workspace lock")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
