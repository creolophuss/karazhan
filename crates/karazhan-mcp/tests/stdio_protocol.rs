use std::{
    io::Write,
    process::{Command, Stdio},
};

use serde_json::{Value, json};

fn mcp_command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_karazhan-mcp"))
}

#[test]
fn stdout_contains_only_mcp_protocol_frames() {
    let directory = tempfile::tempdir().expect("temporary data directory");
    let database_path = directory.path().join("karazhan.sqlite3");
    let mut child = mcp_command()
        .env("KARAZHAN_DATABASE_PATH", &database_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start MCP companion");

    let mut stdin = child.stdin.take().expect("child stdin");
    for frame in [
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "karazhan-test", "version": "0.1.0" }
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "karazhan_query",
                "arguments": {
                    "request": { "type": "list_projects" }
                }
            }
        }),
    ] {
        writeln!(stdin, "{frame}").expect("write MCP frame");
    }
    drop(stdin);

    let output = child.wait_with_output().expect("wait for MCP companion");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let frames = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("stdout line must be JSON"))
        .collect::<Vec<_>>();
    assert_eq!(
        frames.len(),
        3,
        "stdout must contain only request responses"
    );
    assert!(frames.iter().all(|frame| frame["jsonrpc"] == "2.0"));
    assert_eq!(frames[0]["id"], 1);
    assert_eq!(frames[1]["id"], 2);
    assert_eq!(frames[2]["id"], 3);

    let tools = frames[1]["result"]["tools"]
        .as_array()
        .expect("tools/list result");
    let names = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, ["karazhan_command", "karazhan_query"]);

    let query_text = frames[2]["result"]["content"][0]["text"]
        .as_str()
        .expect("query tool text result");
    assert_eq!(
        serde_json::from_str::<Value>(query_text).expect("shared query result"),
        json!({ "type": "projects", "payload": [] })
    );
}

#[test]
fn startup_diagnostics_use_stderr_not_stdout() {
    let output = mcp_command()
        .env_remove("KARAZHAN_DATABASE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run MCP companion without configuration");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("KARAZHAN_DATABASE_PATH"),
        "diagnostic should identify the missing configuration"
    );
}
