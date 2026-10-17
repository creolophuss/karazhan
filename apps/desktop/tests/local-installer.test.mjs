import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const installer = path.join(repositoryRoot, "install.sh");

async function waitFor(pathname, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(pathname);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${pathname}`);
}

test("dependency preflight warns and continues for missing Apps or cmux CLI", async (t) => {
  const source = await readFile(installer, "utf8");
  const start = source.indexOf("check_desktop_dependencies() {");
  const end = source.indexOf("\ncheck_desktop_dependencies /Applications", start);
  assert.ok(start >= 0 && end > start, "dependency preflight must exist");
  const probe = `${source.slice(start, end)}\ncheck_desktop_dependencies "$1" "$2"\nprintf 'continued\\n'`;
  const root = await mkdtemp(path.join(tmpdir(), "karazhan-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemApps = path.join(root, "system-apps");
  const userApps = path.join(root, "user-apps");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const run = () => spawnSync("/bin/sh", ["-c", probe, "probe", systemApps, userApps], {
    env: { PATH: bin }, encoding: "utf8",
  });
  const absent = run();
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /continued/);
  assert.match(absent.stderr, /cmux is not installed/);
  assert.match(absent.stderr, /Claude.*notifications/);
  assert.match(absent.stderr, /Zed is not installed/);
  assert.match(absent.stderr, /Open in Zed/);
  assert.match(absent.stderr, /https:\/\/github.com\/manaflow-ai\/cmux/);
  assert.match(absent.stderr, /https:\/\/zed.dev\/docs\/macos/);

  await mkdir(path.join(systemApps, "cmux.app"), { recursive: true });
  await mkdir(path.join(userApps, "Zed.app"), { recursive: true });
  const appOnly = run();
  assert.equal(appOnly.status, 0, appOnly.stderr);
  assert.match(appOnly.stdout, /continued/);
  assert.match(appOnly.stderr, /cmux App is installed.*CLI.*PATH/);
  assert.doesNotMatch(appOnly.stderr, /Zed is not installed|cmux is not installed/);

  await rm(systemApps, { recursive: true });
  await mkdir(path.join(userApps, "cmux.app"), { recursive: true });
  assert.match(run().stderr, /cmux App is installed/);
  await rm(userApps, { recursive: true });
  for (const command of ["cmux", "zed"]) {
    await writeFile(path.join(bin, command), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, command), 0o755);
  }
  const commands = run();
  assert.equal(commands.status, 0, commands.stderr);
  assert.match(commands.stdout, /continued/);
  assert.equal(commands.stderr, "");
});

test("local installer owns safe Karazhan and Medivh updates", async (t) => {
  const installerSource = await readFile(installer, "utf8");
  assert.doesNotMatch(installerSource, /awb-tauri-spike-tools/);
  assert.match(installerSource, /https:\/\/sh\.rustup\.rs/);
  assert.match(installerSource, /git -C "\$SCRIPT_DIR" rev-list --count HEAD/);
  assert.match(installerSource, /KARAZHAN_INSTALL_ALLOW_DIRTY/);
  assert.match(installerSource, /tauri-install-version\.json/);
  assert.match(installerSource, /CARGO_TARGET_DIR="\$INSTALL_TMP\/app-target"/);
  assert.match(installerSource, /\$INSTALL_TMP\/app-target\/release\/bundle\/macos\/Karazhan\.app/);
  assert.match(installerSource, /rm -rf -- "\$STALE_APP_BUNDLE"/);
  assert.match(
    installerSource,
    /DYLD_LIBRARY_PATH="\$rust_dyld_library_path"[\s\\]+"\$RUST_BIN\/cargo" build/,
  );

  const root = await mkdtemp(path.join(tmpdir(), "karazhan-installer-"));
  const appSource = path.join(root, "build", "Karazhan.app");
  const mcpSource = path.join(root, "build", "karazhan-mcp");
  const appDirectory = path.join(root, "Applications");
  const binDirectory = path.join(root, "bin");
  const profileDirectory = path.join(root, "profiles", "medivh");
  const stateDirectory = path.join(root, "state");
  const hermes = path.join(root, "mock-hermes");
  const mockBin = path.join(root, "mock-bin");
  const cargoHome = path.join(root, ".cargo");
  const rustupHome = path.join(root, ".rustup");
  const cargoLog = path.join(root, "cargo.log");
  const networkLog = path.join(root, "network.log");
  const recordProxy = 'printf "http=%s https=%s all=%s lower=%s args=%s\\n" "${HTTP_PROXY:-}" "${HTTPS_PROXY:-}" "${ALL_PROXY:-}" "${https_proxy:-}" "$*" >> "$KARAZHAN_TEST_NETWORK_LOG"';
  const mcpCommandConfig = path.join(profileDirectory, "mock-mcp-command");
  const mcpDatabaseConfig = path.join(profileDirectory, "mock-mcp-database");
  const rustTarget =
    process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  const baseVersion = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  ).version;
  const commitCount = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout.trim();
  const [major, minor] = baseVersion.split(".");
  const derivedVersion = `${major}.${minor}.${commitCount}`;

  await mkdir(path.join(appSource, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(appSource, "Contents", "MacOS", "Karazhan"), "app\n");
  await writeFile(mcpSource, "#!/bin/sh\nexit 0\n");
  await chmod(mcpSource, 0o755);
  await mkdir(mockBin, { recursive: true });
  await writeFile(path.join(mockBin, "npm"), `#!/bin/sh\n${recordProxy}\nexit 0\n`);
  await writeFile(path.join(mockBin, "pgrep"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(mockBin, "npm"), 0o755);
  await chmod(path.join(mockBin, "pgrep"), 0o755);
  await writeFile(
    path.join(mockBin, "curl"),
    `#!/bin/sh
set -eu
${recordProxy}
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output=$2
    shift 2
  else
    shift
  fi
done
cat > "$output" <<'RUSTUP_INIT'
#!/bin/sh
set -eu
${recordProxy}
mkdir -p "$CARGO_HOME/bin"
cat > "$CARGO_HOME/bin/rustup" <<'RUSTUP'
#!/bin/sh
set -eu
${recordProxy}
toolchain=$3
target=${rustTarget}
bin="$RUSTUP_HOME/toolchains/$toolchain-$target/bin"
mkdir -p "$bin" "$RUSTUP_HOME/toolchains/$toolchain-$target/lib"
cat > "$bin/cargo" <<'CARGO'
#!/bin/sh
${recordProxy}
printf 'dyld=%s args=%s\\n' "\${DYLD_LIBRARY_PATH:-}" "$*" >> "$KARAZHAN_TEST_CARGO_LOG"
CARGO
cat > "$bin/rustc" <<'RUSTC'
#!/bin/sh
if [ "\${1:-}" = "--print" ] && [ "\${2:-}" = "sysroot" ]; then
  CDPATH= cd -- "$(dirname -- "$0")/.." && pwd
fi
RUSTC
chmod 755 "$bin/cargo" "$bin/rustc"
RUSTUP
chmod 755 "$CARGO_HOME/bin/rustup"
RUSTUP_INIT
`,
  );
  await chmod(path.join(mockBin, "curl"), 0o755);
  await writeFile(
    hermes,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "profile" ] && [ "\${2:-}" = "create" ]; then
  mkdir -p "${profileDirectory}/memories" "${profileDirectory}/skills/project-ops" "${profileDirectory}/sessions"
  mkdir -p "${binDirectory}"
  printf 'default soul\\n' > "${profileDirectory}/SOUL.md"
  printf 'user-owned memory\\n' > "${profileDirectory}/memories/USER.md"
  printf 'other memory\\n' > "${profileDirectory}/memories/NOTES.md"
  printf 'project operations\\n' > "${profileDirectory}/skills/project-ops/keep.txt"
  printf 'session state\\n' > "${profileDirectory}/sessions/keep.txt"
  printf '#!/bin/sh\\nexec %s -p medivh "$@"\\n' "$0" > "${binDirectory}/medivh"
  chmod 755 "${binDirectory}/medivh"
  exit 0
fi
if [ "\${1:-}" = "-p" ] && [ "\${2:-}" = "medivh" ] && [ "\${3:-}" = "config" ] && [ "\${4:-}" = "get" ]; then
  case "\${5:-}" in
    mcp_servers.karazhan.command) config_file="${mcpCommandConfig}" ;;
    mcp_servers.karazhan.env.KARAZHAN_DATABASE_PATH) config_file="${mcpDatabaseConfig}" ;;
    *) exit 2 ;;
  esac
  if [ -f "$config_file" ]; then
    cat "$config_file"
    exit 0
  fi
  printf 'Config key not set: %s\\n' "\${5:-}"
  exit 1
fi
if [ "\${1:-}" = "-p" ] && [ "\${2:-}" = "medivh" ] && [ "\${3:-}" = "config" ] && [ "\${4:-}" = "set" ] && [ "\${5:-}" = "--force" ]; then
  case "\${6:-}" in
    mcp_servers.karazhan.command) config_file="${mcpCommandConfig}" ;;
    mcp_servers.karazhan.env.KARAZHAN_DATABASE_PATH) config_file="${mcpDatabaseConfig}" ;;
    *) exit 2 ;;
  esac
  printf '%s\\n' "\${7:-}" > "$config_file"
  exit 0
fi
if [ "\${KARAZHAN_TEST_HERMES_SLEEP:-0}" != "0" ]; then
  sleep "$KARAZHAN_TEST_HERMES_SLEEP"
fi
`,
  );
  await chmod(hermes, 0o755);

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${mockBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    KARAZHAN_TEST_CARGO_LOG: cargoLog,
    KARAZHAN_TEST_NETWORK_LOG: networkLog,
    KARAZHAN_INSTALL_ALLOW_DIRTY: "1",
    KARAZHAN_INSTALL_SKIP_BUILD: "0",
    KARAZHAN_INSTALL_APP_SOURCE: appSource,
    KARAZHAN_INSTALL_MCP_SOURCE: mcpSource,
    KARAZHAN_INSTALL_APP_DIR: appDirectory,
    KARAZHAN_INSTALL_BIN_DIR: binDirectory,
    KARAZHAN_MEDIVH_PROFILE_DIR: profileDirectory,
    KARAZHAN_INSTALL_STATE_DIR: stateDirectory,
    KARAZHAN_HERMES_COMMAND: hermes,
  };
  const run = () =>
    spawnSync("sh", [installer], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });

  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "KARAZHAN_INSTALL_PROXY"]) {
    delete env[key];
  }
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  await stat(
    path.join(rustupHome, `toolchains/1.98.1-${rustTarget}/bin/cargo`),
  );
  const defaultNetwork = await readFile(networkLog, "utf8");
  assert.ok(defaultNetwork.trim().split("\n").every((line) => line.startsWith("http= https= all= lower= args=")), defaultNetwork);
  assert.match(defaultNetwork, /https:\/\/sh.rustup.rs/);
  assert.match(defaultNetwork, /args=toolchain install/);
  assert.match(defaultNetwork, /args=fetch --locked/);
  assert.match(defaultNetwork, /args=ci/);
  assert.match(defaultNetwork, /args=--workspace @karazhan\/desktop run tauri/);
  const cargoCalls = await readFile(cargoLog, "utf8");
  assert.match(cargoCalls, /args=fetch --locked$/m);
  assert.equal(
    await readFile(path.join(profileDirectory, "SOUL.md"), "utf8"),
    await readFile(path.join(repositoryRoot, "blueprints/medivh/SOUL.md"), "utf8"),
  );
  assert.equal(
    await readFile(path.join(profileDirectory, "memories/USER.md"), "utf8"),
    "user-owned memory\n",
  );
  assert.equal(
    await readFile(path.join(profileDirectory, "memories/NOTES.md"), "utf8"),
    "other memory\n",
  );
  assert.equal(
    await readFile(path.join(profileDirectory, "skills/project-ops/keep.txt"), "utf8"),
    "project operations\n",
  );
  assert.equal(
    await readFile(path.join(profileDirectory, "sessions/keep.txt"), "utf8"),
    "session state\n",
  );
  await stat(
    path.join(
      profileDirectory,
      "skills/karazhan/workspace-provisioning/SKILL.md",
    ),
  );
  await stat(
    path.join(
      profileDirectory,
      "skills/karazhan/medivh-karazhan-registration/SKILL.md",
    ),
  );
  await stat(
    path.join(
      profileDirectory,
      "packages/custodian-startup-kit/.agents/skills/workspace-provisioning/SKILL.md",
    ),
  );
  await stat(
    path.join(
      profileDirectory,
      "packages/custodian-startup-kit/.agents/skills/karazhan-mcp-collaboration/SKILL.md",
    ),
  );
  await stat(
    path.join(
      profileDirectory,
      "packages/custodian-startup-kit/.agents/skills/PACKAGE.md",
    ),
  );
  const htmlFiles = [
    "SKILL.md",
    "scripts/am.mjs",
    "references/settings.md",
    "references/video.md",
    "licenses/OFL-Bangers.txt",
    "LICENSE",
  ];
  const medivhHtml = path.join(profileDirectory, "skills/karazhan/answer-me-with-html");
  const kitSkills = path.join(profileDirectory, "packages/custodian-startup-kit/.agents/skills");
  const projectSkills = path.join(root, "project/.agents/skills");
  const childSkills = path.join(root, "project/children/child/.agents/skills");
  const browserLog = path.join(root, "browser.log");
  await writeFile(path.join(mockBin, "open"), '#!/bin/sh\nprintf "opened\\n" >> "$KARAZHAN_TEST_BROWSER_LOG"\n');
  await chmod(path.join(mockBin, "open"), 0o755);
  await cp(kitSkills, projectSkills, { recursive: true });
  await cp(projectSkills, childSkills, { recursive: true });
  for (const [index, installed] of [
    medivhHtml,
    path.join(kitSkills, "answer-me-with-html"),
    path.join(projectSkills, "answer-me-with-html"),
    path.join(childSkills, "answer-me-with-html"),
  ].entries()) {
    for (const file of htmlFiles) {
      assert.deepEqual(
        await readFile(path.join(installed, file)),
        await readFile(path.join(repositoryRoot, "blueprints/skills/answer-me-with-html", file)),
      );
    }
    const amHome = path.join(root, `render-${index}/artifacts/answer-me-with-html`);
    const page = path.join(amHome, "pages/smoke.html");
    const render = spawnSync(process.execPath, [
      path.join(installed, "scripts/am.mjs"), "render", "-", "--no-open", "-o", page,
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        AM_HOME: amHome,
        AM_NO_UPDATE_CHECK: "1",
        KARAZHAN_TEST_BROWSER_LOG: browserLog,
      },
      input: "## A Flow\n```flow\nMedivh -> Workspace\n```\n",
      encoding: "utf8",
    });
    assert.equal(render.status, 0, render.stderr);
    assert.match(await readFile(page, "utf8"), /<svg/);
  }
  await assert.rejects(stat(browserLog));
  assert.match(
    await readFile(path.join(kitSkills, "PACKAGE.md"), "utf8"),
    /Installed Skills: workspace-provisioning, karazhan-mcp-collaboration, answer-me-with-html/,
  );
  await assert.rejects(stat(path.join(profileDirectory, "skills/karazhan/karazhan-mcp-collaboration")));
  await stat(path.join(appDirectory, "Karazhan.app/Contents/MacOS/Karazhan"));
  await stat(path.join(appSource, "Contents/MacOS/Karazhan"));
  await stat(path.join(binDirectory, "karazhan-mcp"));
  await stat(path.join(binDirectory, "medivh"));
  assert.equal(
    await readFile(mcpCommandConfig, "utf8"),
    `${path.join(binDirectory, "karazhan-mcp")}\n`,
  );
  assert.equal(
    await readFile(mcpDatabaseConfig, "utf8"),
    `${path.join(root, "Library/Application Support/com.jiayi.karazhan/karazhan.sqlite3")}\n`,
  );
  assert.match(
    await readFile(path.join(stateDirectory, "baseline/app/Karazhan.app"), "utf8"),
    /^[a-f0-9]{64}\n$/,
  );
  assert.equal(
    await readFile(path.join(stateDirectory, "baseline/app/Karazhan.app.version"), "utf8"),
    `${derivedVersion}\n`,
  );
  assert.equal(
    await readFile(path.join(stateDirectory, "baseline/app/Karazhan.app.commit"), "utf8"),
    `${spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim()}\n`,
  );
  await assert.rejects(
    stat(path.join(stateDirectory, "baseline/medivh/memories/USER.md")),
  );
  assert.ok(
    (await readdir(profileDirectory)).some((name) =>
      name.startsWith("SOUL.md.pre-karazhan-"),
    ),
  );
  assert.ok(
    (await readdir(binDirectory)).some((name) =>
      name.startsWith("medivh.pre-karazhan-"),
    ),
  );

  await writeFile(path.join(appSource, "Contents", "MacOS", "Karazhan"), "same-version-change\n");
  env.HTTP_PROXY = "http://inherited.example:8080";
  env.HTTPS_PROXY = "http://secure.example:8081";
  env.ALL_PROXY = "socks5://all.example:8082";
  env.https_proxy = "http://lower.example:8083";
  await writeFile(networkLog, "");
  const update = run();
  const inheritedNetwork = await readFile(networkLog, "utf8");
  assert.ok(inheritedNetwork.trim().split("\n").every((line) => line.startsWith("http=http://inherited.example:8080 https=http://secure.example:8081 all=socks5://all.example:8082 lower=http://lower.example:8083 args=")), inheritedNetwork);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(
    await readFile(path.join(appDirectory, "Karazhan.app/Contents/MacOS/Karazhan"), "utf8"),
    "app\n",
  );
  assert.match(update.stdout, /no-op/i);

  env.KARAZHAN_INSTALL_VERSION = "0.2.0";
  env.KARAZHAN_INSTALL_PROXY = "http://override.example:8084";
  await writeFile(networkLog, "");
  await rm(cargoHome, { recursive: true });
  await rm(rustupHome, { recursive: true });
  const upgrade = run();
  const overrideNetwork = await readFile(networkLog, "utf8");
  assert.ok(overrideNetwork.trim().split("\n").filter((line) => !line.includes("args=build --offline")).every((line) => line.startsWith("http=http://override.example:8084 https=http://override.example:8084 all=http://override.example:8084 lower=http://override.example:8084 args=")), overrideNetwork);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(
    await readFile(path.join(appDirectory, "Karazhan.app/Contents/MacOS/Karazhan"), "utf8"),
    "same-version-change\n",
  );
  assert.equal(
    await readFile(path.join(stateDirectory, "baseline/app/Karazhan.app.version"), "utf8"),
    "0.2.0\n",
  );
  assert.match(upgrade.stdout, /updated/i);

  env.KARAZHAN_INSTALL_VERSION = "0.3.0";
  env.KARAZHAN_INSTALL_SKIP_APP = "1";
  env.KARAZHAN_INSTALL_APP_SOURCE = path.join(root, "missing", "Karazhan.app");
  const skipApp = run();
  assert.equal(skipApp.status, 0, skipApp.stderr);
  assert.match(skipApp.stdout, /Karazhan app\s+skipped/i);
  assert.equal(
    await readFile(path.join(stateDirectory, "baseline/app/Karazhan.app.version"), "utf8"),
    "0.2.0\n",
  );

  const htmlInstructions = path.join(medivhHtml, "SKILL.md");
  const originalHtml = await readFile(htmlInstructions, "utf8");
  await writeFile(htmlInstructions, `${originalHtml}\nLocal customization\n`);
  env.KARAZHAN_INSTALL_VERSION = "0.4.0";
  const htmlConflict = run();
  assert.notEqual(htmlConflict.status, 0);
  assert.match(htmlConflict.stderr, /locally modified/);
  assert.match(await readFile(htmlInstructions, "utf8"), /Local customization/);
  assert.equal(
    await readFile(path.join(stateDirectory, "baseline/medivh/AGENTS.md.version"), "utf8"),
    "0.3.0\n",
  );
  await writeFile(htmlInstructions, originalHtml);

  env.KARAZHAN_INSTALL_VERSION = "0.2.0";
  const downgrade = run();
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.stderr, /refusing to downgrade/i);
  env.KARAZHAN_INSTALL_VERSION = "0.3.0";
  env.KARAZHAN_INSTALL_SKIP_APP = "0";
  env.KARAZHAN_INSTALL_APP_SOURCE = appSource;

  const launcher = spawn(path.join(binDirectory, "medivh"), [], {
    cwd: root,
    env: { ...env, KARAZHAN_TEST_HERMES_SLEEP: "2" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => launcher.kill("SIGTERM"));
  await waitFor(path.join(profileDirectory, ".medivh-launch.lock", "pid"));
  const duplicate = spawnSync(path.join(binDirectory, "medivh"), [], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already running/i);
  await new Promise((resolve) => launcher.once("exit", resolve));

  await writeFile(mcpCommandConfig, "/different/karazhan-mcp\n");
  env.KARAZHAN_INSTALL_VERSION = "0.4.0";
  const mcpConflict = run();
  assert.notEqual(mcpConflict.status, 0);
  assert.match(mcpConflict.stderr, /MCP configuration conflict/i);
  await writeFile(mcpCommandConfig, `${path.join(binDirectory, "karazhan-mcp")}\n`);

  const localAgents = path.join(profileDirectory, "AGENTS.md");
  await writeFile(localAgents, "locally changed\n");
  const conflict = run();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /locally modified/i);
  assert.equal(await readFile(localAgents, "utf8"), "locally changed\n");
});
