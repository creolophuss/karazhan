# Karazhan（Agent Workbench 阶段 3）产品需求

> 初次定稿：2026-09-21
> 最近修订：2026-09-28
> 状态：用户已确认定稿；阶段 3 唯一事实来源
> 目标读者：用户、产品设计 Child、TDD / 开发 Child
> 用途：作为阶段 3 后续设计、TDD、实现与验收的唯一事实来源

## 0. 文档说明

这份文档重新整理了阶段 3 立项需求、产品原型评审、运行形态 Spike、数据模型复审以及阶段 2.5 真实数据 dry-run 的最终结论。它是自洽文档：后续 Child 不需要阅读旧需求或 coordination 才能理解产品。

自 2026-09-21 用户确认之时起：

- 本文替换 2026-09-19 初始需求、旧原型说明、早期数据模型和与其冲突的 coordination 记录，成为阶段 3 后续设计、TDD、实现与验收的唯一事实来源。
- 旧材料只作为历史证据，不再补充或改变本文需求；后续需求变化必须先修订本文并由用户确认。
- 本文只规定阶段 3 的产品事实和验收结果，不要求 TDD Child 沿用现有 SQL、文件拆分或内部函数命名。
- 文中“必须”表示 MVP 验收条件；“应”表示正常情况下必须满足、只有明确理由才可延期；“可以”表示允许但不要求。

## 1. 产品概述

Karazhan 是 Agent Workbench 阶段 3 的正式产品与工程名称。它是一个运行在用户 MacBook 上的单用户、本地优先个人项目管理产品，服务的不是传统团队工单流程，而是“一个用户通过 Medivh 管理顶层 Workspace，并与多个 Custodian 共同推进长期工作”的日常场景。

产品应让用户快速回答五个问题：

1. 今天真正要推进哪些 Project 或 Task？
2. 每件工作现在处于什么状态，是否被阻塞？
3. 一个复杂工作被拆成了哪些可执行的 Child Task？
4. Agent 最近做了什么，交付了什么，证据在哪里？
5. 从一个 Agent / Task 切换到另一个时，需要先看哪些 Context、进展和证据？

Karazhan 的核心目标是降低用户每天在多个 Agent、Project 和 Task 之间频繁 context switch 的认知成本。Agent 必须先把进度、状态、步骤、阻塞、结论和证据写入自己的 Workspace 文件，再通过 MCP 把需要用户关注的结构化信息同步到 Karazhan；桌面界面负责聚合信息，帮助用户快速聚焦和决策。

Karazhan 是同步与可视化控制面，不是 Agent 运行时或执行前置依赖。Agent Workspace 中的代码、文档、结果和日志是 Agent 执行事实的第一手来源。Agent 在 Karazhan 或 MCP 暂时不可用时仍可继续工作；连接恢复后以已落盘文件为依据，通过明确的幂等命令补同步。阶段 3 不承诺离线消息队列或自动补传。

阶段 3 的核心结果是：SQLite 保存供用户规划、聚焦和操作的 Project、Task、Backlog 与 Today 结构化视图；本地 Workspace、Context 和 `agent_log.md` 继续保留 Agent 的第一手执行事实。Karazhan 不以数据库替代这些文件，而是通过路径绑定、来源记录和 MCP 同步与它们协作。

## 2. 用户与协作者

### 2.1 用户

产品当前只有一个本机用户。用户负责决定今天做什么、调整结构和优先级、处理 blocker、评审 Agent 交付，以及确认迁移和数据恢复操作。

### 2.2 Medivh

Medivh 是用户的顶层 Workspace 与 Backlog 捕获管家。它按已确认目标创建 Project Workspace、稳定本地身份、Context 和必要 instructions。顶层 Workspace 持久化并验证后，Medivh 可以通过 Karazhan MCP 使用同一稳定 UUID 幂等创建或查询对应的顶层 Project，并登记、查询该 Project 的 primary Workspace binding；MCP 不可用时仍先保留完整本地 Workspace，之后以相同身份重试。用户明确要求记录 Backlog 时，Medivh 还可以生成稳定 UUID，并在系统 Root 或用户明确指定且经查询确认的 Project / Task 下新增、查询该 Backlog。Medivh 不创建 Child Project / Task，不维护 Today、progress、业务字段或生命周期，也不编辑、移动、Discard 或 Promote 已有 Backlog，不启动、调度或管理 Custodian。Workspace 准备与顶层登记结束后，由用户在该目录启动 Custodian。

阶段 3 不负责启动、恢复或调度 Medivh、Custodian 或其他 Agent session。

### 2.3 Custodian

Custodian 是统一负责 Project 或 Task Workspace 的 Agent 角色。Parent、Child 和 Sibling 只表示 Custodian Workspace 之间的关系，不是新的 Agent 类型。Custodian 先写自己的 Workspace 文件，再通过 MCP 注册或同步自己的 Project / Task、查询祖先结构与最近进展、创建 Child 节点、维护 Today 并提交交付。Custodian 报告完成只代表“已交付并等待评审”，不能自动把 Project / Task 设为 `done`。

Custodian 不依赖 Codex、Kimi 或其他运行时的用户级 Profile 才能获得角色能力。每个新 Project / Task Workspace 应携带项目级 `.agents/skills/` 启动包，完整包含 `workspace-provisioning` 与 `karazhan-mcp-collaboration`；用户从 Workspace 根目录启动所选 Agent，使身份、instructions、Skill、Context 和本地事实随 Workspace 一起发现与恢复。Medivh 安装并使用 `workspace-provisioning` 与独立的窄权限 Karazhan Skill，不使用 Custodian 的通用 MCP Skill。具体打包与落地计划见 [`custodian-runtime-packaging-plan.md`](custodian-runtime-packaging-plan.md)。

Workspace 的逻辑 Parent/Child 关系不要求物理目录嵌套。创建顶层 Workspace 前必须让用户确认精确目标目录；创建 Child 前必须让用户确认是否使用一个明确的独立目标目录。用户确认独立目录时，通过双方 `context/index.md` 中的稳定 Work ID 和显式绝对路径建立导航；用户不选择独立目录时，才回退到 `<parent-workspace>/children/<child>`。无论采用哪种布局，逻辑关系都不自动授予目标路径写权限。

## 3. 产品原则

1. **Today 优先**：打开应用默认进入 Today，让用户以最少切换恢复当天工作。
2. **一份结构化视图**：Today、Projects & Tasks、Backlog、API 和 MCP 都读取同一业务核心与 SQLite 数据；它是用户的统一控制面，但不替代 Agent Workspace 中的第一手执行事实。
3. **结构与历史分离**：当前状态保存在节点上；发生过的事情记录为不可混淆的 ProgressEvent。
4. **文件优先落盘**：Agent 先把代码、产物、进度、状态和证据写入自己的 Workspace 文件，再通过 MCP 同步结构化视图。Context、Workspace、manifest 和日志不搬进数据库；数据库只保存必要路径、来源和绑定。
5. **不从自然语言静默推断当前状态**：日志可以形成带来源的进展事件，但不能偷偷覆盖 status、priority、parent、blocker 或 Today。
6. **安全迁移优先于自动修复**：来源冲突必须可见；不能靠 mtime 或猜测静默选定“正确值”。
7. **少对象、明确语义**：不为轻量展示另外发明 TaskItem、TodoItem、Comment 或通用 JSON 领域对象。

## 4. 核心概念

### 4.1 全局 Work Tree

系统中的 Project、Task 和 Backlog 共同组成一棵全局工作树。树顶有一个用户不可编辑的系统 Root；界面通常隐藏这个 Root。

允许的父子关系如下：

| Parent | 允许的直接 Child |
|---|---|
| 系统 Root | Project、Task、Backlog |
| Project | Project、Task、Backlog |
| Task | Task、Backlog |
| Backlog | 无；Backlog 在阶段 3 是叶子 |

每个非 Root 节点：

- 有一个稳定 UUID；
- 有且只有一个 Parent；
- 在同一 Parent 下有唯一 key 和明确的手工顺序；
- 可以移动到另一个合法 Parent，但不能形成环；
- 创建后不能原地改变类型。

这个模型允许：嵌套 Project、Project 下的一级 Task、任意必要深度的 Child Task、独立 Task，以及挂在 Root、Project 或 Task 下的 Backlog。

### 4.2 Project

Project 表示长期工作容器。它可以包含子 Project、Task 和 Backlog，也可以拥有自己的状态、优先级、目标、验收条件和 blocker。

Project 的 slug 可空；一旦填写，在所有 Project 中唯一。Project 可以先创建，Workspace 和 Context 路径后补，不要求创建时同时具备。

### 4.3 Task 与 Child Task

Task 是可执行工作。Task 不保存 `project_id`、`root/child` 标记或单独的 TaskItem 类型，其含义由 Parent 决定：

- Parent 是 Root：独立 Task；
- Parent 是 Project：该 Project 的一级 Task；
- Parent 是 Task：Child Task。

Child Task 与其他 Task 是同一种业务对象，拥有自己的 ID、状态、优先级和进展。界面可以把它显示成更轻量的 TaskItem 行，但这只是呈现方式，不是另一份数据。

阶段 3 没有 TodoItem，也没有“唯一下一步”字段。一个 Task 的下一步工作由零个、一个或多个直接 Child Task 表达，并使用同级顺序表示排列。这样不会把多个行动压缩进一段字符串，也不会同时维护 Task、Todo 和 next_action 三份真相。

### 4.4 Backlog

Backlog 表示尚未正式立项的 idea、problem、request 或 research。它可以放在 Root、Project 或 Task 下，但阶段 3 不允许拥有 Child。

Backlog 被推进时不会原地变成别的类型。系统在一个原子操作中：

1. 创建新的 Project 或 Task；
2. 把 Backlog 状态设为 `promoted`；
3. 保存新节点 ID；
4. 保留原 Backlog 作为来源记录。

### 4.5 Today

Today 不是另一棵树，也不是由 status 自动推导的列表。它保存用户明确选择的 Project 或 Task，以及独立的手工顺序。

把节点加入、移出或重排 Today：

- 不改变节点在 Work Tree 中的位置；
- 不改变 priority；
- 不改变 status；
- 不创建或删除 Project / Task。

Backlog 不能进入 Today。

### 4.6 Context

在 Karazhan 产品数据模型中，Context 只是 Project 上的一个可选目录路径，主要给 Agent 阅读。目录中可以有 `index.md`、`coordination/` 或其他文件，但 Karazhan：

- 不扫描目录内容；
- 不建立文件清单；
- 不复制正文、摘要或 digest 到数据库；
- 不把 coordination 文件当作结构化状态源。

Karazhan 当前不为 Task 保存专属 `context_path`。Task 通过产品查询背景时，沿祖先链找到最近的 Project，并使用该 Project 的 `context_path`；独立 Task 若没有 Project 祖先，就没有产品层隐式 Context。这不禁止 Custodian Workspace 在文件系统中拥有自己的 `context/`：该目录及其 `index.md` 由 Workspace 文件契约管理，是文件事实，不由 Karazhan 扫描或完整重建。

### 4.7 ResourceBinding

Project 或 Task 可以绑定外部资源：Workspace、manifest、`agent_log.md`、repository、外部 session、URL、文件或目录。

每条绑定保存节点、资源类型、原始 locator、是否主绑定、当前可用性和来源。相同物理路径可以被多个节点分别绑定；发现共享路径时不能因此合并节点。路径失效只改变可用性，不删除业务对象。

Root 和 Backlog 不拥有 ResourceBinding。

### 4.8 ProgressEvent

ProgressEvent 记录“发生了什么”，只关联 Project 或 Task，不属于 Work Tree。它至少覆盖：

- 普通进展与交付；
- status、priority、parent、blocker 的变化；
- Today 的加入、移除与重排；
- 从 legacy 日志导入的事件。

事件保存发生时间、记录时间、摘要、证据、actor、写入渠道和可选来源绑定。当前字段变化与相应事件必须在同一业务事务中保持一致。

ProgressEvent 不反向充当当前状态。日志同步产生事件后，status 等字段仍须由明确的用户、API 或 MCP 命令修改。

用户也可以为 Project / Task 手工追加带状态的 Step。Step 使用 ProgressEvent 表达，不是新的 Work Tree 节点，也不改变所属 Project / Task 的当前状态或 revision。手工 Step 可使用与工作状态一致的状态文案；UI 默认显示最近 3 条，并允许切换完整列表。

## 5. 状态与生命周期

### 5.1 Project / Task 状态

Project 和 Task 共用以下状态：

```text
planned, ready, in_progress, pending, review, done, cancelled
```

含义：

| 状态 | 用户语义 |
|---|---|
| `planned` | 已规划，但尚未准备执行 |
| `ready` | 条件具备，可以开始 |
| `in_progress` | 正在推进 |
| `pending` | 当前等待外部人员、时间、资源或决定 |
| `review` | 已有交付，等待用户或获授权 Assistant 验收 |
| `done` | 已验收完成 |
| `cancelled` | 已取消，保留历史 |

legacy 的 `waiting` 只在导入边界确定性映射为 `pending`，同时保留原值作为导入证据。新系统不接受 `waiting` 作为当前状态。

系统保留 `review` 与 `done` 状态以及 delivery 事件，但 MVP 不要求单独实现 `submit_delivery` / `review_delivery` 授权命令。用户或 Custodian 通过现有结构化命令记录事件和明确更新状态；日志中的“完成”等自然语言永远不能自动把节点设为 `done`。

### 5.2 Blocker

Blocker 是 Project / Task 上的独立文本条件，不是互斥状态。`in_progress`、`pending` 或 `review` 都可以同时存在 blocker。清除 blocker 不自动改变 status，改变 status 也不自动清除 blocker。

### 5.3 Priority

Project、Task 和 Backlog 使用：

```text
urgent, high, medium, low, none
```

Priority 表示业务重要性；Today 手工顺序表示用户现在想先看、先做什么。两者不得相互暗中改写。

### 5.4 Backlog 分类与状态

Backlog kind：

```text
idea, problem, request, research
```

Backlog status：

```text
captured, considering, ready, promoted, discarded
```

普通“移除”操作把 Backlog 设为 `discarded`。Project / Task 的 `cancelled` 仍是业务状态，不等于 Archive。Project / Task 可以先递归归档；只有已归档子树才能在 Archive 页面二次确认后永久删除。

## 6. 信息架构

一级导航为：

```text
Today
Projects & Tasks
Backlog
Archive
```

阶段 3 不提供 Inbox、独立 Task Detail或 Project Background 页面。Projects & Tasks 左上角提供顶层 Project / Task 创建；Project 右键可创建 Child Project / Task，Task 右键可创建 Child Task。Backlog 与 Today 也提供各自受限的圆形 `+` 创建入口；拥有相应 Workspace 和授权范围的 Custodian 可以经 API / MCP 创建和维护业务对象。

界面采用左侧导航、单一主工作区、中等密度文本列表、弱边框和低视觉噪声。标题和当前状态优先于辅助元数据。Project 标题区及展开内容可以使用温和的分组背景，但风格不得牺牲层级、键盘操作和错误反馈的清晰度。

## 7. 页面需求

### 7.1 Today

打开应用后默认进入 Today。

Today 是一个 Project / Task 混合列表，必须支持：

- 显式加入与移出；
- 拖拽调整手工顺序，并在重启后保持；
- 每行独立展开和折叠；
- `Expand all` / `Collapse all`；
- 行内修改 status 和 priority；blocker 保留在领域 contract 中，但不要求在紧凑 Today 行内编辑；
- 有有效 Workspace 时执行 `Open in Zed`；
- 从其他页面执行 `Move to Today`，已加入时显示 `In Today`；
- 从条目最右侧向左滑后露出 Delete，仅移出 Today；未 reveal 时 Delete 不可聚焦。
- 通过标题旁的圆形 `+` 创建只有一行 Description 的 Quick item；它以 checkbox 外观修改普通 Task status，可拖拽排序、可删除，但不出现在 Projects & Tasks。

首次进入时，Today 行默认展开。每行展开区只显示该节点的一级直接 Child Task，不递归展开更深后代，也不显示 Child Project 或 Backlog。

如果一个 Parent 和它的直接 Child Task 都是 Today 的显式成员：

- 数据层保留两条 Today membership 和各自顺序；
- Parent 展开区不重复显示该 Child；
- Child 从 Today 移除后，它重新出现在 Parent 的展开区。

直接 Child Task 使用轻量 Task 行呈现，但仍读写普通 Task 的 status，而不是 Todo checkbox 数据。若最终 UI 使用勾选外观，它只能是把 Task status 改为 `done` 的快捷操作，不能形成第二份完成状态。

Quick item 也不是新领域类型，而是带 `is_quick_item` 标记的普通 Task；用户输入的 Description 存入其必填标题字段。创建必须原子加入 Today，checkbox 继续使用带 revision 检查的 Task 状态命令，删除使用带幂等、actor/channel 与事务语义的专用命令。Projects & Tasks 投影必须排除 Quick item。

Today 展开区显示最近 3 条有业务意义的 Steps / Progress，并可切换 Show all / Show recent；Project、Task 和直接 Child Task 均可通过右键 Add step。Today membership/order、Parent 变更、普通字段保存等结构化审计事件继续保留在完整 timeline，但不进入 Recent / All steps、不占用最近 3 条名额，也不单独使条目出现 disclosure。Today 底部继续显示全局 Recent Progress。Today 首屏读取产品数据库，不等待 Workspace 检查或日志同步完成。

当前可见的 Today 与 Projects & Tasks 页面必须及时反映 HTTP / MCP 等外部进程的写入：可见期间至多约 1 秒刷新一次，窗口重新聚焦或页面恢复可见时立即刷新。后台刷新不得重置用户的展开/折叠状态，不得并发发起重叠查询，相同数据不得触发无意义的页面重渲染。

### 7.2 Projects & Tasks

Projects & Tasks 是同一全局 Work Tree 的 Project / Task 投影；系统 Root 和 Backlog 不在这张页面的主树中显示。

页面必须：

- 展示嵌套 Project、Project 下的 Task、Task 下的 Child Task以及独立 Task；
- 使用缩进和连接线表达递归层级；行内只显示当前节点名称和可空 Description，不重复祖先 breadcrumb，也不显示系统 Root；
- 支持在合法 Parent 之间移动节点，并在移动前检查类型、环和同级 key / position 冲突；
- 支持同级手工排序；
- 在 Project 范围内提供 `Expand all` / `Collapse all`，Project disclosure 使用 chevron；
- 提供 `Move to Today` / `In Today` 和 `Open in Zed`；
- 直接编辑 status 和 priority；
- 顶层圆形 `+` 创建 Project / Task；Project 右键创建 Child Project / Task，Task 右键创建 Child Task；创建表单包含 Name、Description，Project 另含可选本地 Path；
- Project / Task 右键提供 Add step 和 Archive，不提供直接永久删除；
- 展开内容使用一个统一详情卡片：Recent steps 在上、未单独进入 Today 的递归 Child Project / Task 在下；某个 Child 自己进入 Today 后，它与其子树不再在 Parent 卡片重复；Project 的 Steps 聚合仍归属该卡片的自身与后代业务事件并标明后代来源；Steps 默认最近 3 条并可切换完整列表；
- 底层继续保留 goal、acceptance、blocker、Context、ResourceBinding 和完整事件能力，但本页不要求展示大型 Details 面板，也不读取 Context 正文。

Task 的详细区域默认折叠；存在 Child 或 Step 的节点显示 disclosure。Child Task 直接出现在树中，不再另建 To-do 区块，也不在详情中复制同一 Child。

本页面不跳转到独立 Task Detail。用户在树行和展开区完成高频查看与编辑。

### 7.3 Backlog

Backlog 页面是全局 Work Tree 中所有 Backlog 叶子的专用投影。默认列表隐藏已 promoted 和 discarded 的条目。每行显示标题与 Description，并以稳定对齐的列展示 kind、priority 和 tags；kind 与 priority 使用无边框文本，不显示 status 或 Parent breadcrumb。生命周期状态仍保留在领域模型中，用于 Promote、Discard 和显式查询。

页面必须支持：

- 使用与 Today、Projects & Tasks 一致的标题样式和标题旁圆形 `+`；创建表单包含 Title、Description、Parent、Kind、Priority 和逗号分隔 Tags；
- 提供 Parent、kind、priority 和 tag 过滤，不提供可见 status 过滤；Parent、kind 和 priority 为无边框控件，Tag 是唯一带搜索框边框的字段；
- Parent 选择器列出所有合法 Project / Task，并用隐藏系统 Root 的完整 breadcrumb 表达层级；筛选请求并发返回时只允许最后一次选择更新列表；
- 通过右键菜单打开 Edit、Move、Promote 和 Discard，不在列表行常驻这些按钮；
- 在当前行展开 Edit 表单，编辑 title、Description、kind、priority 和 tags；
- `Save` 保存并收起，`Cancel` 恢复最近一次已保存内容；
- Discard 在当前行确认，不使用必须跳转的详情页，并保留来源 Backlog；
- Promote 前选择创建 Project 或 Task，以及合法 Parent；
- Promote 成功后保留来源、设置内部生命周期状态并显示目标节点链接；
- 不提供独立 History 页面或 History 区块。

Backlog 拖拽可跨越当前可见行。落点仍在同一 Parent 时只更新同级顺序；落到不同 Parent 的条目位置时，必须在一个原子命令中同时改变 Parent 和目标位置，失败不得留下部分移动。

### 7.4 Search（延期）

Search 不在当前阶段 3 MVP 中实现，也不启动对应 Child；以下内容只保留为以后重新立项时的需求候选，不构成当前验收门槛。

未来的 Search 应统一查找 Project、Task 和 Backlog，并按类型分组展示结果，至少考虑：

- title、summary；
- Project slug、节点 UUID；
- status、priority、Parent；
- blocker；
- Backlog kind 和 tags；
- ResourceBinding locator，例如 Workspace、manifest 或 repository 路径。

搜索结果进入对应树位置或页面行，不要求独立详情页。Context 目录正文不在搜索范围内。

### 7.5 Settings / Import（延期）

Settings 与 Import 不在当前阶段 3 MVP 中实现，也不启动对应 Child。现有底层 migration、备份恢复及隔离测试证据继续保留；以下页面能力只作为以后重新立项时的需求候选：

- 产品数据库位置和 schema version；
- API / MCP 可用状态；
- legacy 导入范围配置；
- dry-run 报告、冲突和 apply；
- 增量日志同步状态；
- 数据备份、恢复和结构化导出；
-外部资源可用性检查。

危险操作必须显示目标、影响范围和可恢复方式。单个 Project、日志或路径失败不能让整个页面和其他 Project 不可用。

### 7.6 Archive

Archive 是 Project / Task 的递归归档投影：

- 归档一个节点时，选中节点及全部后代原子进入 Archive，并从 Projects & Tasks 隐藏；
- 归档子树的全部 Today membership 同时移除，但节点、ProgressEvent 和其他历史保留；
- 系统 Root 永远不能归档或删除；归档 Parent 不能接收新 Child；
- `cancelled` 与 Archive 是不同概念；
- Archive 提供 Reopen：恢复选中子树及使其重新可见所必需的已归档祖先；此前移除的 Today membership 不自动恢复；操作必须带 revision 检查、幂等事务语义并记录 ProgressEvent；
- 永久删除只出现在 Archive 页面，必须明确展示后代数量并二次确认；未归档节点不得永久删除。

## 8. 关键用户流程

### 8.1 开始一天

1. 用户打开应用，直接看到上次保存的 Today 顺序。
2. 用户展开 Project / Task，查看一级 Child Task 和 Recent Progress。
3. 用户拖拽调整 Today 顺序；业务 priority 不变。
4. 用户可把不再关注的项目移出 Today；原节点、状态和树位置不变。
5. 日志同步在后台运行，新事件出现后更新 Recent Progress，不阻塞首屏。

### 8.2 恢复并推进一个 Task

1. 用户从 Today 或 Projects & Tasks 找到 Task。
2. 用户查看目标、验收条件、blocker、直接 Child Task 和最近进展。
3. 如果有有效 Workspace，用户点击 `Open in Zed`。
4. 用户或 Agent 更新 Task 状态，或创建 / 更新 Child Task 来表达下一步工作。
5. 系统在同一操作中保存当前字段和相应 ProgressEvent。

### 8.3 Agent 交付与用户验收

1. Custodian 先把交付和证据写入自己的 Workspace，再追加 delivery 事件；需要评审时再通过通用状态命令明确进入 `review`。
2. 用户检查摘要、证据和 Workspace 结果。
3. 通过时明确设为 `done`；不通过时设回 `in_progress` 并记录原因。
4. MVP 不要求专用交付授权命令；系统不得因为日志出现“完成”等自然语言而自动进入 `done`。

### 8.4 推进 Backlog

1. 用户在 Backlog 行点击 Promote。
2. 用户选择目标类型 Project 或 Task、Parent 和必要字段。
3. 系统使用 idempotency key 执行一个原子命令。
4. 成功时创建目标、保留来源 Backlog 并建立 promotion link。
5. 失败时 Backlog 保持原状，返回可安全重试的结构化错误。

Workspace 和产品层 Context path 可以在目标创建后由负责该工作的 Custodian 补充；promotion 不因缺少 Workspace 而失败。

### 8.5 在 Zed 中打开工作

1. UI 只提交 Project / Task ID，不提交任意路径或命令。
2. Rust core 从可信 ResourceBinding 解析 Workspace，canonicalize 后检查其为允许 root 内的现有目录。
3. macOS 使用 Launch Services，例如 `/usr/bin/open -a Zed <path>`；不能假设 GUI 进程的 `PATH` 中存在 `zed` CLI。
4. 缺少 Workspace、路径越界、Zed 未安装或启动失败时返回明确错误。
5. 打开 Zed 不改变折叠、Today 顺序、status 或 priority。

## 9. API 与 MCP

桌面 UI、loopback HTTP API 和 stdio MCP 必须调用同一 Rust application/domain core，不能各自复制业务规则。

MVP 对外能力至少覆盖：

- 列出、读取、创建和更新 Project / Task / Backlog；
- 读取 Work Tree、列出 Child、移动节点和同级重排；
- 更新 status、priority 和 blocker；
- 加入、移出和重排 Today；
- 追加和查询 ProgressEvent；
- 新增、检查和列出 ResourceBinding；
- 编辑、discard 和 promote Backlog；
- 查询 Project Context 路径；
- 执行 legacy dry-run、apply 和增量日志同步；
- 通过受信节点 ID 执行 Open in Zed。

所有写操作必须：

- 使用稳定 ID；
- 记录 actor、channel / source 和 timestamp；
- 支持 revision 乐观并发控制；
- 对安全重试使用 idempotency key；
- 返回结构化错误和冲突，不以字符串日志作为唯一反馈；
- 与 UI 命令遵守完全相同的树、类型、状态和事务不变量。

API / MCP 不负责 Agent session 生命周期，也不提供任意 shell 命令或任意文件路径访问。

## 10. 阶段 2.5 迁移（延期）

用户已决定当前阶段不继续 Settings、Import 或真实阶段 2.5 cutover。本节保留已经确认的数据语义、安全边界和未来实施要求，但不构成当前 MVP 验收门槛；不得据此对真实阶段 2.5 数据执行操作。

### 10.1 迁移目标

用户不应重新手工创建已有 Project、Task、Backlog、路径绑定和进展历史。迁移必须只读访问 legacy 源、先报告后应用、可重复执行且不产生重复对象。

迁移仅扫描请求中明确给出的受信 `source_root` 和范围，绝不能默认扫描整个 home。它读取：

- `registry/tasks.yaml`；
- `registry/backlog.yaml`；
- 范围内的 `.workbench/task.yaml`；
- 范围内的 `agent_log.md`；
- Project `context/` 目录是否存在及其路径。

它不读取 Context 目录中的文件，也不读取或导入 coordination 内容。

### 10.2 身份与映射规则

1. 产品建立固定系统 Root。
2. 每个 legacy Project slug 使用冻结 namespace 生成独立 Project UUIDv5；保留 slug，标题暂以 slug 合成，用户以后可修改。
3. 所有 legacy Task 保留原 UUID。
4. legacy Root Task 仍是 Task，成为对应 Project 的一级 Task；不能把它改造成 Project。
5. 原有 Child Task 父链保持不变。
6. 每个非空 legacy `next_action` 使用冻结规则生成确定性 UUIDv5 Child Task：title 为原文本，Parent 为源 Task，初始状态 `planned`，priority 为 `none`。
7. 不同时创建 TodoItem，也不在 Parent 上保留另一份 current next_action。
8. legacy Backlog 保留 UUID；有效 project_id 对应的条目挂到该 Project，无效或空 project_id 的条目挂 Root，不根据 notes 猜测 Parent。
9. 已 promoted 的 Backlog 链接到迁移后的 Project 或 Task，不能重复创建目标。
10. 每个 legacy Task 的 Workspace、manifest 和 log 分别形成 ResourceBinding；共享 locator 不合并节点。
11. Project 只保存 `context_path`，不产生 ContextFile 或 BackgroundSource。
12. legacy `today=true` 为 Project / Task 创建 Today membership；当前冻结快照全部为 false。
13. legacy `waiting` 映射为 `pending`，原值保留在 ImportRecord。

### 10.3 Dry-run 与 apply

第一次导入必须先 dry-run，同时生成 canonical JSON 和用户可读报告。报告至少包含：

- source snapshot 和 ruleset version；
- 计划 create / update / no-op / skip / blocked 的对象；
- 每个来源到目标 ID 的映射；
- conflict code、severity、证据、安全默认和是否需确认；
- report digest 与 apply eligibility。

`apply_eligible=true` 只表示当前计划没有 blocker，不表示 importer 已实现、数据已应用或用户已确认切换。

Apply 必须携带完整 report digest、ruleset version 和 source snapshot 前置条件。dry-run 后任一来源 digest 变化，都必须拒绝 apply 并要求重新 dry-run。

导入可以让互不相关的记录独立成功或失败，但任何失败都必须使 ImportRun 明确标为 `partial_failure` 并列出未应用记录。身份或关系无法安全确定时，相关对象必须 blocked。

### 10.4 幂等规则

- 相同 source key 与相同 digest：no-op；
- 相同 source key 与不同 digest：报告 `source_record_mutated`，不覆盖已有 Event；
- 新的日志 section key：创建一个 ProgressEvent；
- 相同 apply idempotency key 和报告：返回原结果；
- 相同 key 携带不同 report digest：返回冲突。

日志 section 的身份不能只依赖 `last_heading` 或整个文件 digest；heading 可重复、cursor 可能为空或落后、append 会持续改变文件 digest。

### 10.5 必须处理的真实冲突

| 场景 | 安全结果 |
|---|---|
| cancelled 旧 Task 与 active 新 Task 共享 Workspace / manifest / log | 保留两个 UUID 和各自绑定；报告共享及 manifest identity mismatch，不合并 |
| manifest 存在但 registry 缺少 Task | 生成 Task 候选并报告来源差异，不丢 manifest |
| registry 或 cursor 早于日志 | 导入新增 ProgressEvent，不覆盖 status |
| cursor 为空但日志已有内容 | 从头按 section identity 扫描并去重 |
| Agent session 未登记 | 保持 unknown，不从进程、目录或作者名猜测 |
| 已 promoted Backlog 的目标存在 | 保留来源与目标链接，不重复创建 |
| 同 Parent 下 key 冲突 | 确定性生成安全 key 并报告，不丢节点 |
| Context 含敏感文件 | 完全不扫描、不摘要、不在错误或报告中回显正文 |
| Parent 类型非法、父链成环或身份含糊 | blocker；不自动改挂 Root或改变节点类型 |
| 未识别 legacy 字段 | 保留在 ImportRecord 的 source snapshot / extension 中，不塞进领域对象的通用 JSON |

### 10.6 冻结真实快照的预期结果

2026-09-21 08:55 的只读快照应得到：

| 项目 | 预期 |
|---|---:|
| Project slug | 5 |
| legacy Task | 13 |
| 非空 legacy next_action | 12 |
| Backlog | 3 |
| manifest | 12 |
| 不同 agent_log.md | 12 |
| 日志 section / ProgressEvent 计划 | 157 |
| TodayItem | 0 |
| ResourceBinding | 39 |
| WorkNode 总数 | 34：1 Root + 5 Project + 25 Task + 3 Backlog |

冻结报告 digest 为：

```text
b87311efb576fa616c273b053d06969ef808620a3e670b67027ad99f7c356196
```

该快照预期 blocker 为 0，但包含共享资源、manifest identity mismatch、同级 key 冲突和 log cursor 落后等 warning。

### 10.7 Cutover 与回退

切换分为：

1. **兼容模式**：只做 dry-run 和只读日志同步；SQLite 尚不是结构化事实源。
2. **核对模式**：用户确认 Work Tree、Project UUID、legacy Root Task、next_action Child Task、Backlog Parent 和冲突处理。
3. **切换前**：创建数据库备份、legacy registry 快照、完整报告，并记录 cutover timestamp。
4. **切换后**：SQLite + API / MCP 成为 Work Tree、状态和 Today 的权威来源；registry 只作快照或导出，不再双向写。
5. **持续兼容**：Workspace、manifest、日志、Context 和 coordination 留在原位；日志可继续只读增量同步。
6. **回退**：停止新系统写入，恢复切换前数据库或放弃新库；不得把新库内容静默反写 legacy YAML。新库独有写入应先结构化导出。

## 11. 本地运行架构

阶段 3 固定采用：

```text
Tauri 2 desktop app
React + TypeScript UI
Rust application/domain core
SQLite local database
stdio MCP companion
loopback HTTP API（仅应用运行期间在线）
```

运行要求：

- 用户日常只需启动 `Agent Workbench.app`，不手工维护数据库、Web server 或 daemon。
- React 不直接访问 SQLite、文件系统或 shell。
- Tauri IPC、HTTP 和 MCP 只是 adapter，共用一套领域命令。
- stdio MCP 由 MCP host 按需启动；stdout 只输出协议帧，日志写 stderr 或文件。
- HTTP 只绑定 `127.0.0.1` / `::1`，使用高熵 token，并验证 Host / Origin。
- 应用退出后 HTTP 端口释放；MVP 不增加常驻 LaunchAgent。
- SQLite 数据位于 macOS Application Support 中的产品目录；正式 bundle identifier 由实现冻结。
- 仓库根 `install.sh` 从当前 checkout 构建并以用户权限安装或更新 `Karazhan.app`、stdio MCP companion、Medivh Hermes Profile 中明确列出的托管文件、Medivh 窄权限 Karazhan Skill、非扫描的 Custodian startup package 与 `medivh` 命令；它还以冲突即停止的方式只补齐 Medivh Profile 的 `mcp_servers.karazhan.command` 和 `KARAZHAN_DATABASE_PATH` 两个配置叶子，不执行 `git pull`，不覆盖检测到本地修改的托管文件或不同的现有 MCP 配置，也不改写其他 Hermes 配置和运行状态。`memories/USER.md`、其他 memories、sessions 与非托管 Skills 始终归用户所有，不纳入 baseline、不替换也不删除。
- 普通 release build 只生成可执行文件，不在 repository target 中留下可被 Launch Services 发现的 `.app`；`install.sh` 在临时 target 中生成安装 bundle，安装完成后仅保留 `~/Applications/Karazhan.app`，避免同一 bundle identifier 出现两份可启动副本。
- 全部托管组件使用同一个 commit 派生安装版本：`tauri.conf.json` 提供基础 `major.minor`，完整 Git 历史中 `HEAD` 可达 commit 数作为 patch；构建通过临时 Tauri 配置把该版本写入 App，不修改 tracked 文件。正常安装要求非 shallow checkout 且不存在 tracked 未提交修改，并为每个目标分别记录内容 baseline、已部署版本与完整 commit SHA。安装版本更高才更新已有目标，相同版本为 no-op，降级拒绝；缺失目标可补装。首次接管无版本的已有托管目标前必须生成同目录时间戳备份，内容完全一致时可直接建立 baseline。`KARAZHAN_INSTALL_SKIP_APP=1` 跳过 App 构建、校验和安装，但继续处理 MCP 与 Medivh 组件。安装结束逐项目标报告新建、接管与备份、更新、no-op 或跳过状态。
- `medivh` 命令以前台方式启动 `hermes -p medivh chat`；启动前同时检查对应 Hermes 进程与 PID lock，活动实例存在时拒绝重复启动，只清理由 launcher 留下且 owner PID 已不存在的陈旧 lock。
- 构建所需外网默认经本机 `127.0.0.1:7897` 代理；缺少仓库固定版本的 Rust 工具链时，安装脚本先通过官方 rustup 安装到标准用户目录，不依赖临时工具链路径；脚本通过代理显式执行锁文件约束的 Cargo 依赖下载，之后再执行离线 Rust 构建；代理可由显式安装参数覆盖。

Tauri Spike 已验证共享 core、SQLite、HTTP、stdio MCP、安全 Open in Zed、100 行拖拽和重启持久化。正式开发仍需补充可重复的 5 次 GUI 冷启动、空闲 60 秒 CPU / RSS 以及适当的 GUI 验收证据；它们不改变产品模型。

## 12. 数据可靠性、备份与恢复

### 12.1 数据库约束

SQLite 必须直接或通过领域事务保证：

- 固定且不可修改、移动、删除的唯一 Root；
- 合法父子类型、无环、类型不可变；
- 同 Parent key 和 position 唯一；
- Project / Task / Backlog 节点与对应类型数据完整匹配；
- Today 只引用 Project / Task；
- ProgressEvent 和 ResourceBinding 只引用 Project / Task；
- imported ProgressEvent 的来源身份唯一，且 source binding 属于同一 subject；
- Backlog promotion 只指向 Project / Task。

### 12.2 Schema migration

- 每次连接启用 foreign key；运行时配置 WAL 和有界 busy timeout。
- migration 使用固定编号和 checksum；已应用版本 checksum 不匹配时停止写入。
- App 与 MCP 使用进程间锁，不能并发迁移；竞争方收到 `migration_busy`。
- 升级前先 WAL checkpoint，再用 SQLite online backup 创建完整备份；不能在 WAL 活跃时简单复制主文件。
- 备份必须先通过 integrity check；migration 在事务中执行，失败即 rollback。
- MVP 不做会丢数据的 down migration。

### 12.3 恢复与导出

- 恢复先写临时路径，验证 integrity、foreign keys 和核心对象计数，再原子替换目标数据库。
- 失败库保留供诊断，不自动删除。
- 结构化备份至少覆盖 Work Tree、类型字段、ResourceBinding、Today 和 ProgressEvent，并附引用清单。
- 数据库备份不声称备份了 Workspace、Context 或日志正文。
- 只有用户明确选择“完整本地备份”时，才复制 Context 目录；不得自动上传或扩散敏感文件。

## 13. 性能、可用性与隐私

### 13.1 性能和故障隔离

- 正常本地规模下，Today 和 Projects & Tasks 应接近即时打开。
- 导入、日志同步、路径检查和索引工作必须异步，不能阻塞主要 UI。
- 100 行的滚动、展开、折叠和双向拖拽应保持流畅，拖拽落点清楚。
- 单个坏 YAML、坏日志、缺失路径或损坏 Project 不能使整个产品不可用。
- HTTP 启动失败时桌面 UI 仍可用，并明确显示 Agent API unavailable；不能静默换端口。

### 13.2 安全与隐私

- 数据默认只保存在本机。
- 不记录、复制或回显密码、Token、私钥及 Context 中的敏感正文。
- 前端不能提供任意路径读取或任意命令执行能力。
- 导入和路径解析受 trusted root、显式 scope、canonicalization 和软链边界约束。
- 所有写入保留 actor、来源和时间；导入事件还保留 source item identity 与 digest。
- 阶段 3 不提供 LAN、公网或远程 MCP 访问。

## 14. 明确不做

以下内容不属于阶段 3 MVP：

- 内嵌对话 Assistant；
- Agent session 启动、恢复、控制或多 Agent 调度；
- Git worktree、分支或 Workspace 生命周期管理；
- Project Background 阅读 / 编辑页面；
- Context 文件索引、全文检索、摘要、向量库、RAG 或 Memory；
- TodoItem、唯一 next_action、Comment、Activity Interval、started / ended 计时；
- overdue、due date、milestone、risk、decision item；
- 通用 ChangeLog 或领域对象上的 metadata / payload JSON；
- Inbox；
- Search 页面与统一搜索能力（延期，以后另行立项）；
- Settings / Import 页面、legacy 导入、日志同步和真实阶段 2.5 cutover / rollback（延期，以后另行立项）；
- 多用户、团队 SaaS、RBAC、计费、移动端；
- LAN / 公网访问、云同步、PostgreSQL、账号认证；
- 常驻 daemon / LaunchAgent；
- Plane API 或数据格式兼容；
- 通用插件市场或工作流引擎。

说明：Backlog tags、ProgressEvent evidence 以及 ImportRecord 报告快照属于有明确用途的结构数据，不是用于逃避领域建模的通用 JSON 字段。

## 15. MVP 验收场景

### 15.1 Work Tree 与业务规则

1. 空库创建唯一固定 Root；第二个 Root、修改 / 移动 / 删除 Root 均被拒绝。
2. 所有允许父子关系可创建；Task→Project、Backlog→任意 Child 和形成环的移动被拒绝。
3. 创建无 slug、Workspace 和 Context 的 Project 成功，之后可分别补充。
4. 同一非空 Project slug、同 Parent key 或 position 冲突被拒绝，原顺序不被部分破坏。
5. 独立 Task、Project 一级 Task 和多层 Child Task 都能展示、移动和重排。
6. “轻量行动项”创建为普通 Child Task；数据库不存在 TodoItem、TaskItem 或 next_action 副本。
7. Project / Task 当前字段变化与 ProgressEvent 保持同事务一致。
8. `pending` 可用、`waiting` 不能直接写入；blocker 与任意工作状态正交。

### 15.2 Today 与页面交互

9. Project 和 Task 可以加入 Today，Backlog 不能加入。
10. Today 顺序可拖拽并在重启后保持，且不改变 priority、status 或树内 position。
11. Parent 与直接 Child 同时在 Today 时保留两条 membership，Parent 展开区抑制重复；移除 Child membership 后恢复内嵌显示。
12. Today 默认展开、逐行折叠和 Expand / Collapse all 均可用；展开只显示一级直接 Child Task，并能查看或追加 Steps；圆形 `+` 创建的 Quick item 可勾选、排序和删除，且不出现在 Projects & Tasks。
13. Projects & Tasks 以缩进递归展示 Project / Task，支持顶层和上下文创建、Add step、递归 Archive；Archive 可 Reopen，并只允许确认后永久删除已归档子树，Reopen 不恢复旧 Today membership。Backlog 默认隐藏 promoted / discarded 条目，正确显示 Description 及对齐的 kind、priority、tags。
14. Backlog 可从圆形 `+` 创建完整条目；右键 Edit / Move / Discard / Promote 各自独立；跨 Parent 拖拽原子更新 Parent 与位置；Promote 重试不重复创建目标。
15. **Search（延期，不计入当前 MVP 验收）**：未来可按标题、状态、优先级、Parent、slug / ID、blocker、Backlog 标签和资源路径找到对象。

### 15.3 导入与同步（延期，场景 16–24 不计入当前 MVP 验收）

16. 冻结快照 dry-run 产生 34 WorkNode、39 ResourceBinding、157 ProgressEvent 计划和 0 TodayItem，canonical report digest 与基线一致。
17. 5 个 Project 使用独立 UUIDv5；13 个 legacy Task 保留 UUID；5 个 legacy Root Task 成为 Project 一级 Task。
18. 12 个 next_action 生成 12 个确定性 Child Task；没有 Todo / next_action 重复数据。
19. 共享 Workspace 的 cancelled / active Task 均被保留；同一 locator 可以关联多个节点。
20. manifest-without-registry、空 / 落后日志 cursor、`waiting` 映射、promoted Backlog 和同级 key 冲突均有固定测试。
21. 同一快照重复 dry-run 结果一致；apply 后重放不增加节点、绑定或事件。
22. dry-run 后来源发生变化时 apply 被拒绝；单记录失败产生明确 partial failure，不损坏无关对象。
23. Context 和 coordination 内容从未被扫描、摘要、复制或写入错误输出。
24. 连续同步同一日志 section 两次不产生重复 Event；同 key 内容变更报告冲突且不覆盖原 Event。

### 15.4 接口、本地集成和恢复

25. UI、HTTP 与 MCP 对同一领域命令产生相同结果和错误语义。
26. Custodian 能创建 Child Task、追加 progress、维护 Today 并查询 Project / Task 汇总。
27. Open in Zed 只接受节点 ID；当前用户 home 或应用数据 Workspace root 内的 available primary Workspace 可打开，缺失、越界和注入路径被安全拒绝；结构化失败信息在 Today 行内完整可见且不覆盖相邻控件。
28. 应用启动时 HTTP 需要 token；应用退出后端口释放；stdio MCP 不向 stdout 写协议外日志。
29. App 与 MCP 并发启动 migration 时只有一个执行；另一个得到明确错误。
30. 当前可见的 Today 与 Projects & Tasks 在外部写入后约 1 秒内刷新，并在 focus / visibility 恢复时立即刷新；后台刷新不重置展开状态、不产生重叠请求或相同快照重渲染。
31. **Import 恢复演练（延期，不计入当前 MVP 验收）**：完成一次 dry-run → apply → replay no-op → migration 故障 → restore → 核心计数核对演练。
32. 恢复后外部路径缺失只更新 availability，不删除节点或阻断其他页面。
33. 正式开发补齐 5 次 GUI 冷启动、空闲 CPU / RSS 和关键桌面交互验收证据。
34. Medivh Profile 安装后可发现窄权限 Karazhan Skill，并通过已配置的 `karazhan-mcp` 对持久化且已验证的顶层 Workspace 执行幂等 Project 创建/查询和 primary Workspace binding 登记/查询；还可以按用户明确请求，在 Root 或用户明确指定且经查询确认的 Project / Task 下幂等新增、查询 Backlog。写入保留 `medivh` actor provenance，现有不同 MCP 配置不被静默覆盖，且 Medivh 仍不能管理 Child、Today、progress、业务字段、状态、既有 Backlog 编辑/移动/Discard/Promote 或 Custodian session。
35. Today 中的 Project 展开后显示未单独进入 Today 的递归 Child Project / Task；独立 Today Child 及其子树不在 Parent 卡片重复。Parent Recent / All steps 聚合该可见子树的业务事件、排除审计事件，并为后代事件标明来源。

## 16. 定稿确认

以下四项来自旧原型与新 Work Tree 的结合处，已经随本文整体评审一并确认：

1. **Projects & Tasks 默认折叠**：本文采用“树层级可见，Task 详情默认折叠；Project 范围可一键展开 / 折叠”。
2. **Child Task 的轻量完成交互**：本文允许使用 checkbox 外观，但它只能修改 Task status，不能引入 Todo 完成字段。
3. **Backlog 排序范围**：本文最初采用同一 Parent 内拖拽排序；2026-09-25 用户评审已改为允许跨可见行拖拽，并原子完成跨 Parent 移动与定位。
4. **Search 是否纳入 MVP**：本文最初保留独立 Search；2026-09-25 用户决定当前阶段不做、以后再议，因此 Search 入口和场景 15 均不进入当前 MVP 验收。

本文其余数据语义、迁移口径、运行边界和验收场景也已确认。后续 TDD Child 必须只以本文为需求事实源；现有 schema、dry-run 和验证矩阵可以作为实现输入与证据，但不得覆盖本文。

2026-09-24 至 2026-09-25 的用户评审进一步确认：正式产品名为 Karazhan；系统 Root 在界面隐藏；Project / Task UI 创建、递归 Archive、Archive 后永久删除、紧凑 status / priority 编辑、手工 Step 与 Projects & Tasks 的统一详情卡片进入 MVP。Projects & Tasks 的该轮桌面视觉已由用户验收通过。

2026-09-25 的 Backlog 桌面评审进一步确认：Backlog 使用右键操作、圆形 `+` 创建、无可见 status、Description 与对齐元数据、跨 Parent 原子拖拽；Today 增加普通 Task 语义的 Quick item；Archive 增加不恢复 Today membership 的 Reopen。该轮实现与桌面视觉已由用户验收通过。
