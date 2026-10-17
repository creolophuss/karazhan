# Karazhan

English | [简体中文](README.zh-CN.md)

Karazhan is a local-first macOS workbench for people who work with several Agents. It shows Projects, Tasks, progress, and decisions in one place. Agents keep their working files in their own Workspaces and can synchronize structured information through MCP.

## Features

- Organize Projects and Tasks in a hierarchy, with status, priority, and progress.
- Choose and order work in Today. Capture ideas in Backlog and promote them when ready.
- Archive and reopen work. Open a bound Workspace in Zed.
- Use one Rust business core through the desktop UI, stdio MCP, and local HTTP adapter.
- Use the bundled Medivh and Custodian instructions and Skills for local work.
- Preview Context notifications and send approved text to registered Codex or Claude sessions.

Karazhan does not start or schedule Agents. It does not index Context files or provide cloud sync. Search and Settings/Import have no current desktop UI. The notification adapter supports Codex queue and Claude/cmux; Hermes reception is not integrated.

## Install from source

You need macOS, Xcode Command Line Tools, Node.js 26 with npm 11, and an installed [Hermes Agent](https://github.com/NousResearch/hermes-agent) command on `PATH`. The full installer uses Hermes to create the Medivh profile. Rust 1.98.1 with rustfmt and Clippy is pinned; the installer can install it through official rustup if missing. SQLite is bundled; a separate SQLite CLI is optional.

[cmux](https://github.com/manaflow-ai/cmux) supports terminal collaboration and Claude notifications. [Zed](https://zed.dev/docs/macos) supports **Open in Zed**. Install them from their official sites, or use Homebrew:

```sh
brew tap manaflow-ai/cmux
brew install --cask cmux
brew install --cask zed
```

The installer checks both dependencies. If either is missing, it warns and continues. Claude notifications need the cmux CLI on `PATH` and a working cmux session. An installed cmux App without its CLI gets a separate warning. Zed does not need its optional CLI.

Clone the complete history, then run:

```sh
git clone https://github.com/creolophuss/karazhan.git
cd karazhan
./install.sh
```

The installer builds the current checkout and installs:

- `~/Applications/Karazhan.app`
- `~/.local/bin/karazhan-mcp` and `~/.local/bin/medivh`
- Managed Medivh files and the Custodian startup package in `~/.hermes/profiles/medivh`

Add `~/.local/bin` to your shell's `PATH` if needed. Configure your model in Hermes before running `medivh`. The installer does not configure model credentials. The source-built App is unsigned and unnotarized.

Installation requires a clean checkout and full Git history. Versions use `<Tauri major>.<minor>.<commit count>`. Updates reject downgrades and changed managed files. Existing unversioned targets are backed up before replacement. User memories, sessions, and other Skills stay user-owned; the reference `memories/USER.md` is never installed over your memory.

To update, fetch and review source changes, then rerun `./install.sh`. The installer does not run `git pull`. Use `KARAZHAN_INSTALL_SKIP_APP=1 ./install.sh` to install only MCP and Medivh components. Network commands inherit your proxy environment. Set `KARAZHAN_INSTALL_PROXY` only for an installer-specific proxy override.

## Use

Start Karazhan from Applications. Use `medivh` to prepare a top-level Project Workspace and register it through MCP. Medivh can also capture Backlog items you explicitly request. You then start the Project's Custodian in that Workspace. The Custodian keeps local files first and synchronizes its own structured work.

For Context notifications, run `node scripts/context-notify.mjs --help`. The adapter works without the App or a resident service. See the [product and integration reference](docs/product-requirements.md) for session registration, local Hooks, MCP configuration, and data safety.

## Develop

```sh
npm ci
npm run check
npm run desktop:dev
```

`npm run check` runs Rust formatting, Clippy, Rust and frontend tests, TypeScript checks, and the frontend production build. Tests use isolated data. Read [AGENTS.md](AGENTS.md) before contributing. New requirements belong in the [product reference](docs/product-requirements.md) before implementation.

## License

[MIT](LICENSE). Bundled third-party components retain their license notices.
