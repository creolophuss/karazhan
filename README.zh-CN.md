# Karazhan

[English](README.md) | 简体中文

Karazhan 是一个本地优先的 macOS 工作台，适合同时与多个 Agent 协作的用户。它集中展示 Project、Task、进展和决策。Agent 在各自的 Workspace 中保留工作文件，并可通过 MCP 同步结构化信息。

## 功能

- 按层级组织 Project 和 Task，记录状态、优先级和进展。
- 在 Today 中选择和排列工作。在 Backlog 中记录想法，准备好后再转为正式工作。
- 归档和重新打开工作。在 Zed 中打开已绑定的 Workspace。
- 桌面界面、stdio MCP 和本机 HTTP 适配器共用 Rust 业务核心。
- 提供 Medivh 和 Custodian 的指令及 Skill，支持本地文件工作流程。
- 预览 Context 通知，将用户批准的文字发送到已登记的 Codex 或 Claude 会话。

Karazhan 不启动或调度 Agent，不索引 Context 文件，也不提供云同步。当前桌面端没有 Search 和 Settings/Import 页面。通知适配器支持 Codex queue 和 Claude/cmux，尚未接入 Hermes 接收。

## 从源码安装

需要 macOS、Xcode Command Line Tools、Node.js 26、npm 11，以及已安装并位于 `PATH` 的 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 命令。完整安装器使用 Hermes 创建 Medivh Profile。仓库固定 Rust 1.98.1，并要求 rustfmt 和 Clippy；缺少时，安装器可通过官方 rustup 安装。SQLite 已内置，单独的 SQLite CLI 为可选工具。

[cmux](https://github.com/manaflow-ai/cmux) 用于终端协作和 Claude 通知。[Zed](https://zed.dev/docs/macos) 用于 **Open in Zed**。可从官方网站安装，也可使用 Homebrew：

```sh
brew tap manaflow-ai/cmux
brew install --cask cmux
brew install --cask zed
```

安装器检查这两个依赖。缺少任一依赖时会警告并继续。Claude 通知要求 cmux CLI 位于 `PATH`，并且有可用的 cmux 会话。已安装 cmux App 但缺少 CLI 时，安装器会单独说明。Zed 不要求安装可选 CLI。

克隆完整历史，然后执行：

```sh
git clone https://github.com/creolophuss/karazhan.git
cd karazhan
./install.sh
```

安装器构建当前 checkout，并安装：

- `~/Applications/Karazhan.app`
- `~/.local/bin/karazhan-mcp` 和 `~/.local/bin/medivh`
- `~/.hermes/profiles/medivh` 中的 Medivh 托管文件和 Custodian 启动包

如有需要，将 `~/.local/bin` 加入 shell 的 `PATH`。运行 `medivh` 前，请先在 Hermes 中配置模型。安装器不配置模型凭证。源码构建的 App 未签名，也未经过公证。

安装要求 checkout 干净且 Git 历史完整。版本格式为 `<Tauri major>.<minor>.<commit count>`。更新会拒绝降级或覆盖已被本地修改的托管文件。替换无版本的既有目标前会先备份。用户记忆、会话和其他 Skill 始终归用户所有；参考文件 `memories/USER.md` 不会覆盖用户记忆。

更新时，先获取并审阅源码变化，再运行 `./install.sh`。安装器不执行 `git pull`。只安装 MCP 和 Medivh 组件时，执行 `KARAZHAN_INSTALL_SKIP_APP=1 ./install.sh`。联网命令继承代理环境变量。仅需为安装器单独指定代理时，才设置 `KARAZHAN_INSTALL_PROXY`。

## 使用

从 Applications 启动 Karazhan。使用 `medivh` 创建顶层 Project Workspace，并通过 MCP 登记。Medivh 也可以记录用户明确要求的 Backlog。然后，由用户在该 Workspace 中启动 Project 的 Custodian。Custodian 先维护本地文件，再同步自己负责的结构化工作。

Context 通知用法见 `node scripts/context-notify.mjs --help`。适配器不依赖 App 或常驻服务。会话登记、本地 Hook、MCP 配置和数据安全说明见[产品与集成参考](docs/product-requirements.md)。

## 开发

```sh
npm ci
npm run check
npm run desktop:dev
```

`npm run check` 执行 Rust 格式检查、Clippy、Rust 和前端测试、TypeScript 检查及前端生产构建。测试使用隔离数据。贡献前请阅读 [AGENTS.md](AGENTS.md)。新增需求须先写入[产品参考](docs/product-requirements.md)，再实现。

## 许可证

[MIT](LICENSE)。内置的第三方组件保留各自的许可证声明。
