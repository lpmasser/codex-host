# WorkBuddy CN 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `workbuddy-cn`；国内版 WorkBuddy CN，与 `workbuddy` 国际版身份隔离 |
| 原生接口与传输方式 | WorkBuddy 桌面应用内置 CodeBuddy CLI 的 ACP stdio；共用 `@codexhost/adapter-codebuddy` |
| 已验证的原生版本 | 国内版 App 5.6.2 / 内置 CLI 2.147.0：只静态读取 `product.json` 与 CLI 入口字符串，未运行；共用实现的历史在线验证来自国际版 CLI 2.137.1 |
| 交付范围 | 预装发行候选；B12 为未完成 P1，依赖共用 CodeBuddy Session 自主 Turn 的独立 PR，合入后再提国内版 PR；Desktop 与完整委派未验收 |
| 参考插件 | `qoder` / `qoder-cn`：独立 Harness ID 与薄工厂；`workbuddy`：共用 Adapter、Session 与历史实现 |
| 最后验证 | 2026-11-16，macOS 27.2 / arm64 / Node 24.21.0；未启动国内版 CLI、Desktop 或 Host |

## 能力

下表按国内版插件登记。实现位于共用的 `packages/adapters/workbuddy` 与 `packages/adapters/codebuddy`；证据列中的测试是共用实现回归，不等于国内版真实产品验收。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | packages/host-runtime/test/installed-harness-plugins.test.ts、test/plugin.test.ts | ID、显示名、入口与工厂一致 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | test/plugin.test.ts、packages/host-runtime/test/installed-harness-plugins.test.ts | 薄工厂调用 `@codexhost/adapter-workbuddy/plugin`，每个 Host 连接独立实例 |
| A3 | 检查 | 必做 | P0 | 支持 | packages/adapters/workbuddy/src/workbuddy-adapter.ts、packages/adapters/codebuddy/src/codebuddy-adapter.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/workbuddy/test/distributions.test.ts | 共用检查路径；显式指向另一发行时返回 unavailable |
| A4 | 创建 Session | 必做 | P0 | 支持 | packages/adapters/workbuddy/src/workbuddy-adapter.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/workbuddy/test/delegation.test.ts | 传播 Session 环境；未显式选择时使用原生默认 |
| A5 | 执行 Turn | 必做 | P0 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/streaming-boundaries.test.ts、packages/adapters/workbuddy/test/workbuddy-adapter.test.ts | ACP 流式输出与单一终态 |
| A6 | 取消 | 必做 | P0 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/codebuddy/test/codebuddy-adapter.test.ts（busy/cancel 用例）、packages/adapters/workbuddy/test/workbuddy-adapter.test.ts | 只取消匹配 Turn，取消后可进入下一轮；此处引用的测试不证明迟到输出隔离 |
| A7 | 只读快照 | 必做 | P0 | 支持 | packages/adapters/codebuddy/src/history.ts、packages/adapters/workbuddy/src/common.ts | packages/adapters/workbuddy/test/history-path.test.ts、packages/adapters/workbuddy/test/history-derivation.test.ts | 按发行根只读，不触发 Agent |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | packages/adapters/workbuddy/src/workbuddy-adapter.ts、packages/adapters/workbuddy/src/distribution.ts | packages/adapters/workbuddy/test/distributions.test.ts | 两身份 Native Ref 分开；跨身份 resume/fork/rollback 拒绝 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | packages/adapters/codebuddy/src/codebuddy-adapter.ts、packages/adapters/codebuddy/src/session.ts | packages/adapters/codebuddy/test/codebuddy-adapter.test.ts（busy/cancel 用例）、packages/adapters/workbuddy/test/native-auth-errors.test.ts | 类型化错误、诊断脱敏、活动 Turn 互斥 |
| A10 | 关闭 | 必做 | P0 | 支持 | packages/adapters/codebuddy/src/codebuddy-adapter.ts | test/plugin.test.ts、packages/host-runtime/test/installed-harness-plugins.test.ts | 关闭工厂实例与插件注册，不残留进程 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | packages/adapters/workbuddy/src/product-models.ts、packages/adapters/codebuddy/src/configuration.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/workbuddy/test/product-models.test.ts | Windows 用产品文件补目录；macOS 使用 ACP 目录 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | packages/adapters/codebuddy/src/configuration.ts、packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts | 原生 thinking 选项与读回 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | packages/adapters/codebuddy/src/configuration.ts、packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/workbuddy/test/delegation.test.ts | 活动 Session 内切换；无人值守冲突拒绝 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | packages/adapters/workbuddy/src/workbuddy-adapter.ts | packages/adapters/workbuddy/test/delegation.test.ts、packages/adapters/workbuddy/test/workbuddy-adapter.test.ts | unattended 映射 fullAccess；冲突返回 invalidRequest |
| B5 | Fork | 原生有则必做 | P1 | 支持 | packages/adapters/workbuddy/src/common.ts | packages/adapters/workbuddy/test/distributions.test.ts、packages/adapters/workbuddy/test/history-derivation.test.ts | 共用实现并静态确认国内版 CLI 2.147.0 入口；国内版在线未验收 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 支持 | packages/adapters/workbuddy/src/common.ts | packages/adapters/workbuddy/test/distributions.test.ts、packages/adapters/workbuddy/test/history-derivation.test.ts | `forkAcrossCwd` 声明 true；国内版在线未验收 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 支持 | packages/adapters/workbuddy/src/common.ts | packages/adapters/workbuddy/test/distributions.test.ts、packages/adapters/workbuddy/test/history-derivation.test.ts | `rollbackLastTurn` 声明 true；国内版在线未验收 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/streaming-boundaries.test.ts、packages/adapters/codebuddy/test/turn-output.test.ts、packages/adapters/codebuddy/test/history-projection.test.ts | 工具、命令、文件、推理与压缩投影 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/codebuddy/test/interactions.test.ts | 原生审批交互 |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/codebuddy/test/codebuddy-adapter.test.ts（approval/question 关联与响应验证用例） | 原生提问交互，不自动作答，拒绝无效或重复响应 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 支持 | packages/adapters/codebuddy/src/subagents.ts、packages/adapters/codebuddy/src/subagent-history.ts | packages/adapters/workbuddy/test/subagent-configuration.test.ts、packages/adapters/codebuddy/test/subagent-observer.test.ts、packages/adapters/codebuddy/test/workbuddy-root-cache.test.ts | 观察与只读 transcript；缓存命中的 read/locate 仍校验根；国内版在线未验收 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 不支持 | packages/adapters/codebuddy/src/session.ts | 下述「B12 原生依据与 P1 结论」 | 未完成 P1；依赖共用 Session 的独立 PR，本分支不实现，不能视为原生不适用 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/codebuddy/test/usage-metering.test.ts | 累计 usage 与上下文窗口 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 支持 | packages/adapters/codebuddy/src/session.ts | packages/adapters/workbuddy/test/workbuddy-adapter.test.ts、packages/adapters/codebuddy/test/usage-metering.test.ts | 发布 `usage.request` / `usage.history` |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | packages/adapters/workbuddy/src/workbuddy-adapter.ts、packages/adapters/workbuddy/src/delegation.ts | packages/adapters/workbuddy/test/delegation.test.ts | 执行策略与 Thread 环境有测试；真实委派未验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | packages/adapters/workbuddy/src/delegation.ts | packages/adapters/workbuddy/test/delegation.test.ts | 仅验证系统提示与 Runtime 环境注入；国内版真实向下委派未验收 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.svg | packages/host-runtime/test/installed-harness-plugins.test.ts | 名称、图标、链接 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | packages/host-runtime/test/installed-harness-plugins.test.ts | 安装指引与官方下载地址 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | packages/adapters/workbuddy/src/installation.ts | packages/adapters/workbuddy/test/installation.test.ts | 国内版公共更新通道；只提供手动安装包 |
| C4 | 首次安装 | 可选 | P2 | 不适用 | — | — | WorkBuddy 以桌面应用安装，插件只提供安装指引 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | manifest.json、packages/adapters/workbuddy/src/command.ts、packages/adapters/workbuddy/src/plugin.ts | packages/adapters/workbuddy/test/distributions.test.ts、test/plugin.test.ts | `launchCommand` 与 `CODEXHOST_WORKBUDDYCN_COMMAND`；显式路径校验发行 |
| C6 | 会话导入 | 可选 | P2 | 支持 | packages/adapters/codebuddy/src/session-import.ts、packages/adapters/workbuddy/src/distribution.ts | packages/adapters/workbuddy-cn/test/data-consumers.test.ts、packages/adapters/codebuddy/test/session-import.test.ts | 列表与解析通过 profile 的同一根身份校验；真实插件工厂回归，未在线验收 |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | packages/adapters/codebuddy/src/usage-statistics.ts、packages/adapters/workbuddy/src/distribution.ts | packages/adapters/workbuddy-cn/test/data-consumers.test.ts、packages/adapters/codebuddy/test/usage-statistics.test.ts | 枚举与直接读取均验证根，持久化 source ID 须位于所选根的 projects 内 |
| C8 | 账号额度 | 可选 | P2 | 待验证 | — | — | 未实现账号额度；原生是否提供额度接口未核实 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json、根 tsconfig.json、package-lock.json | `npm run build:typescript` | 新 workspace 包与 TS reference |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | packages/host-runtime/test/installed-harness-plugins.test.ts | 预装清单包含 `workbuddy-cn` |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts | 真实 Loader 与可搬移 bundle |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/workbuddy/workbuddy-harness-integration.md、docs/index.md、docs/architecture/harness-plugin-runtime.md、docs/architecture/harness-executable-discovery.md | 人工核对链接与描述 | 两身份、发现、配置隔离与未验证边界 |
| D5 | 其他 | 可选 | P2 | 支持 | packages/shared-contracts/src/harness-display-settings.ts | tests/e2e/renderer-workbuddy-variants.spec.ts、packages/renderer-extension/test/renderer-binding-probe.test.ts | 默认显示顺序紧随 `workbuddy`；使用共享路由，无 Renderer 专用分支 |

## 受限与已知缺口

- B5–B7、B11、C6：能力与共用实现测试一致，国内版 CLI 2.147.0 静态包含公开 `--fork-session` 与 `_codebuddy.ai/session/rollback` 入口；国内版真实对话、历史、Fork/修订、子 Agent 与会话导入尚未在线验收，不能把国际版实机结果当国内版证据。
- B12：原生具备自主 Turn，但共用 Session 尚未接入，未声明 `autonomousTurns.observe`。空闲时的原生正文通知没有公共 Turn 承接；这是未完成 P1，不是仅缺在线验收。2026-11-16 已定：先由共用 CodeBuddy Session 的独立 PR 实现，合入后再提国内版 PR；本分支不实现自主 Turn。
- B15：执行策略、权限模式与 Thread 环境已有测试；真实跨 Harness 委派链路未验收。
- B16：只注入系统提示与 Runtime 环境变量并验证参数；原生 Agent 工具入口能运行子任务，但不能据此认定它能发现并调用 codexhost CLI。国内版真实向下委派仍待后续 P2 验收，不能作为完整委派交付。
- C8：未实现账号额度查询；原生是否提供额度接口尚未核实，Desktop 不显示该入口。

### B12 原生依据与 P1 结论

2026-11-15 静态读取国内版 App 5.6.2 随附的 `cli/dist/codebuddy-headless.js`（内嵌 CLI 版本 2.147.0；SHA-256 `3e88ad84178ba2903c48c40e7d7149d10d209976afd3fc8b7fa738e4524a470d`），没有启动 CLI 或访问账号目录：

- `AcpView.triggerDrain` 在没有外部 Prompt 时注入 `prompt: []`、`isDrain: true` 的内部请求。
- `drainBackgroundTaskNotifications` 调用 `announceUnsolicitedTurn`，建立 ACP 事件转发，运行 `agentService.runDefault`，最后发送 `session_end`。
- `announceUnsolicitedTurn` 通过 `buildUnsolicitedTurnUpdate` 向 ACP 连接发送自主 Turn 开始通知。因此「原生有则必做」条件成立。
- 共用 `packages/adapters/codebuddy/src/session.ts` 的 update handler 只向 `#active?.output` 投影正文，没有自主 Turn 的身份分配与终态处理，也未声明对应能力。

结论：B12 是未完成 P1，依赖共用 CodeBuddy Session 自主 Turn 的独立 PR；该 PR 合入后再提交国内版 PR，本分支只记录依赖，不实现自主 Turn。依赖需要处理原生开始/结束、与用户 Turn 的互斥、历史和关闭，不能靠更改清单结论放行。国内版真实后台运行仍未验收。

## 插件外改动

- `packages/adapters/codebuddy/src/common.ts`、`packages/adapters/codebuddy/src/history.ts`：产品 profile 的数据根校验回调，在公共根解析边界调用，不包含 WorkBuddy 分类规则。
- `packages/adapters/codebuddy/src/usage-statistics.ts`：直接读取持久化 source ID 也经过同一根校验，不依赖先枚举。
- `packages/adapters/codebuddy/src/subagent-history.ts`：父历史缓存命中也调用公共根解析，不把上次读取时的根身份当作长期授权。
- `packages/adapters/workbuddy/src/command.ts`：发行身份、数据根与产品配置校验。
- `packages/adapters/workbuddy/src/common.ts`：按发行的运行 profile 与历史能力。
- `packages/adapters/workbuddy/src/discovery.ts`：按发行选择安装。
- `packages/adapters/workbuddy/src/distribution.ts`：发行表与身份判定。
- `packages/adapters/workbuddy/src/installation.ts`：按发行的版本检查。
- `packages/adapters/workbuddy/src/plugin.ts`：按发行的工厂与启动覆盖。
- `packages/adapters/workbuddy/src/product-models.ts`：Windows 产品文件模型目录。
- `packages/adapters/workbuddy/src/workbuddy-adapter.ts`：按发行的 Adapter 绑定。
- `packages/adapters/workbuddy/test/command.test.ts`：命令行与产品配置回归。
- `packages/adapters/workbuddy/test/credential-bootstrap.test.ts`：凭据引导随发行参数。
- `packages/adapters/workbuddy/test/delegation.test.ts`：发行环境与无人值守委派。
- `packages/adapters/workbuddy/test/discovery.test.ts`：按发行发现。
- `packages/adapters/workbuddy/test/distributions.test.ts`：发行身份、数据根与产品配置隔离。
- `packages/adapters/workbuddy/test/root-isolation.test.ts`：真实文件布局中的独立 CLI、显式配置、权限与符号链接数据根隔离。
- `packages/adapters/workbuddy/test/nonregular-snapshot.test.ts`：独立子进程中的 FIFO 快照有界回归。
- `packages/adapters/workbuddy/test/installation.test.ts`：按发行的版本检查。
- `packages/adapters/workbuddy/test/product-models.test.ts`：Windows 产品模型目录。
- `packages/host-runtime/test/harness-plugin-loader.test.ts`：真实插件 Loader。
- `packages/host-runtime/test/installed-harness-plugins.test.ts`：预装组合与显式启动覆盖。
- `packages/renderer-extension/test/renderer-binding-probe.test.ts`：共享路由。
- `packages/renderer-extension/test/settings/pages.test.ts`：连接页。
- `packages/renderer-extension/test/workbuddy-selection.test.ts`：按 Agent 的选择状态。
- `packages/shared-contracts/src/harness-display-settings.ts`：默认显示顺序。
- `scripts/release/harness-plugins.json`：预装清单。
- `scripts/release/prepare-npm.mjs`：npm remote Broker 集合。
- `tests/release/npm-package.test.mjs`：npm remote 的 Broker 安装/状态/停止/卸载断言。
- `tests/e2e/renderer-workbuddy-variants.spec.ts`：两身份 Renderer e2e（本轮未运行）。
- `tsconfig.json`：Workspace TS reference。
- `package-lock.json`：新 workspace 包依赖锁定。
- `docs/architecture/harness-executable-discovery.md`：发现文档。
- `docs/architecture/harness-plugin-runtime.md`：插件运行时文档。
- `docs/harnesses/workbuddy/workbuddy-harness-integration.md`：功能文档。
- `docs/index.md`：文档索引。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为（2026-11-16，基于 `3acf888f7` 的子 Agent 缓存修订） | `npx vitest run --config tests/vitest.config.js packages/adapters/codebuddy/test packages/adapters/workbuddy/test packages/adapters/workbuddy-cn/test`（与插件加载、发行用例合并执行） | exit 0；CodeBuddy 23 files、202 passed；WorkBuddy/CN 19 files、283 passed，含 54 条启动矩阵、12 条真实工厂数据消费、1 条 FIFO 及 4 条预热后根切换回归 |
| 插件加载（同批执行） | `packages/host-runtime/test/harness-plugin-loader.test.ts`、`packages/host-runtime/test/installed-harness-plugins.test.ts` | exit 0；2 files、77 passed、1 skipped；跳过的是需要 `CODEXHOST_OPENCODE_REAL_COMMAND` 的 OpenCode 真实 CLI 用例 |
| 发行（同批执行） | `tests/release/npm-package.test.mjs`、`tests/release/payload.test.mjs` | exit 0；2 files、85 passed、1 skipped；跳过的是 Windows 专用 npm CLI 启动用例 |
| 原生边界 | 只读取国内版 App 5.6.2 / 内置 CLI 2.147.0 的 `product.json` 与公开入口字符串 | 未启动 CLI；不构成原生运行验证 |
| Host 集成 | 未启动 Host 或 Desktop | 未验证 |
| 真实原生验收 | 国内版真实对话、历史、Fork/修订、认证与取消 | 未执行；OpenSpec tasks 4.2 仍未完成 |
| Desktop / 委派 | 国内版连接页、选择器、设置卡片与真实委派 | 未验收 |
| 静态检查（数据根修订） | `npm run build:typescript`、`npm run typecheck`、`npm run lint` | 均 exit 0；逐项日志随交付记录 |
| Renderer（`bc441fa0f` 的既有记录） | `npm run build:renderer` | exit 0；数据根修订没有重跑 Renderer |
