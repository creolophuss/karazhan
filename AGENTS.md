# AGENTS.md

本文件是本仓库统一的 coding agent 工作指南，适用于 Codex、Claude Code、Kimi 以及其他自动化编程代理。无论使用哪一种工具，都应遵守本文的项目背景、建模约定、部署边界和验证要求；工具自身的通用规则不能覆盖本仓库更具体的约束。

## 项目与事实来源

Karazhan 是本地优先的 Agent 工作可视化与同步产品。开始产品工作前依次阅读：

1. `docs/product-requirements.md`：产品目标、范围、延期项与验收的唯一事实来源；
2. `docs/current-capabilities-and-agent-design.md`：当前实现能力与 Medivh/Custodian 协作设计；
3. `docs/acceptance-traceability.md`：当前覆盖证据；
4. `docs/deferred-work-handoff.md`：仅在用户重新激活延期范围时使用；
5. `README.md` 与 `docs/development-and-operations.md`：工程和运行入口。

连续工作时复用当前上下文。普通用户回复不触发重新读取上述文档或整套任务记录。首次启动、上下文丢失或中断后恢复、已知外部变化、信息缺失或冲突时，读取必要内容；实际阶段、依赖消费和上游约束检查仍按既有边界执行。本地分析、改稿和验证不查询 Karazhan。实际远端操作、用户明确要求查询，以及冲突或未决写入恢复时，才执行对应查询；保留远端写入所需的版本和独立确认。

新需求必须先进入并经用户确认于 `docs/product-requirements.md`，再实施代码。旧 Child Context、historical requirement delta、delivery summary、coordination 和外层 shared-context 只作历史证据，不能覆盖或扩展正式需求。

## 沟通与文本输出

与用户对话、编写报告及其他文本时，遵循 ASD-STE100 简化技术英语或其思想。中文采用相同原则；英文在适用时使用受控词汇。只有按标准核对后，才能声明完全符合标准。

- 用短句和常见、准确的词。每句表达一个主要意思。
- 优先使用主动语态。明确谁做什么，写清条件和指代。
- 同一概念使用同一术语。首次使用必要的技术术语时解释含义。
- 先写结果或所需行动。操作步骤按执行顺序排列，每步写一个行动。
- 删除重复表达、模糊修饰、习语和装饰性语言。区分事实、假设和不确定性。
- 保留代码、命令、路径、标识符、引用和必要技术术语的准确形式。不要为缩短文本而遗漏必要信息。

参考：[ASD-STE100 官方说明](https://www.asd-ste100.org/STE_faq.html)。

## 工程边界

- React 只通过集中 TypeScript client 调用 Tauri；Tauri IPC、HTTP 与 MCP 复用 shared Rust application/domain core。
- 使用 TDD，以最小改动满足已确认需求；不得顺手实现 Search、Settings/Import 或真实阶段 2.5 cutover 等延期范围。
- 阶段 2.5 registry、manifest、日志、Workspace、Context 和 coordination 始终只读；测试只使用内存库、临时目录或明确隔离的开发数据。
- 保持 revision、idempotency、actor/channel、事务、结构化错误和 ProgressEvent 语义。
- 完成前运行与风险相称的 focused tests；产品改动以 `npm run check` 为完整质量门。

## agent_log.md 维护约定

本仓库根目录维护 `agent_log.md`，供中控 Agent 收集进展信息。要求：

- **何时写**：在实际交付或需要后续恢复的停工点合并追加记录。普通分析、改稿、小修复和单次验证不单独记账。关键授权、影响执行的决策、阻塞和未决外部操作及时留存；授权和决策写入相应权威文件，日志只留必要摘要和位置。实际同步仍保留发送前的准确请求信息和简短确认。
- **怎么写**：append 模式，不覆写、不删改历史。每条格式：

      ## YYYY-MM-DD HH:MM
      <自由文本：干了什么、进展如何、卡在哪、下一步>

- **原则**：记录变化、结果、必要证据位置和下一步，不复述已有正文。普通回复和暂定稿不构成阶段交接。Karazhan 同步限于满足本轮明确交付条件的首次完整成果、实际阶段交付、重大里程碑，以及影响执行或需要用户关注的关键变化；连续普通修订和重复展示不单独同步。具体边界见产品需求 §2.8。
