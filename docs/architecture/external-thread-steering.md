# 外部 Thread 的「调整方向」

codexhost 对外部 Harness Thread 保留一个「调整方向」操作，按当前 Session 的能力选择送达方式：

- **原生接受**：Session 声明 `capabilities.steer` 时，Host 发送公共命令 `turn.steer`，由 Adapter 调用原生插入原语。原生接受后负责将输入恰好执行一次、不丢失、不重复；执行可以发生在当前 Turn，也可以在紧接着的下一原生 Turn。Host 不取消当前 Turn，也不为这次接受另发 `turn.start`。
- **停止后重发（退路）**：Session 未声明能力时，Host 继续取消当前 Turn，等待它终结，再把本次输入作为新 Turn 执行。

早期设计只确认了停止后重发，因此曾决定“不增加公共 `turn.steer`”。原生插入原语与接受回执得到确认后，这一前提不再成立。公共 `turn.steer` 表达原生接受，不保证同轮执行；未声明能力的 Adapter 继续使用原有退路。

官方 Codex Thread 仍透传原生 `turn/steer`。各 Harness 的原生依据与验证层级见 `docs/harnesses/` 下对应文档，例如 [`../harnesses/pi/pi-steer.md`](../harnesses/pi/pi-steer.md)。

## 公共契约与执行

- `HarnessSessionCapabilities.steer` 只有在 Session 能把输入交给原生插话原语时才为 `true`；缺省表示不支持。
- `TurnSteerCommand { turnId, input }` 定义在 `packages/harness-adapter/src/text-session.ts`。Adapter 在 Harness 确认接受或入队后返回 `{ accepted: true }`，不等待插入实际执行完毕。
- `ExternalTurnSteering` 统一校验非空文本、`expectedTurnId` 和 `threadId + clientUserMessageId` 去重。原生拒绝不会自动改走退路，也不会自动重试。
- `turn/steer` 回执包含 `turnId` 和 `delivery`：`nativeAccepted` 表示原生已接受，`turnId` 仍是提交时的目标 ID，不是最终执行位置；`newTurn` 表示停止旧 Turn 后已启动替换 Turn，`turnId` 是该新 Turn 的 ID。

Host 统一发布插话的 `userMessage` Item；Adapter 只报告原生事实。Desktop 提交的 `clientUserMessageId` 写入 Item 的 `clientId`，用于结算乐观 steer 消息。投影时机按 Session 声明决定：

- `nativeExecutionLifecycle` 缺省或为 false：原生接受后，Host 在请求目标 Turn 上发布一次，保持既有路径。并发 Turn 终态等待已接受输入的投影；后续自主 Turn 使用空 input，避免复制接受消息。
- 声明 `nativeExecutionLifecycle: true`：Session 通过 `input.consumed { inputId, consumingTurnId, input, clientUserMessageId? }` 报告实际消费事实。事件属于 Session，应在消费 Turn 开始后、结束前交付；可以先于命令回执。Host 按 Session 内唯一的输入身份在消费 Turn 发布一次，重复事实不重复发布。该声明要求提供消费事实，Host 不设计时器猜测归属。当前由 Claude 声明，其他 Adapter 无需改动。

刷新后的历史完全按 Adapter 的原生历史解析，不强行合并原生 Turn。DSH 对已提交 steer 的 requestId 跳过实时自主 Turn 输入回显，原生日志与历史仍保留输入；这里的空 input 表示没有新的待展示用户消息。

### 执行状态的拥有者

`packages/host-runtime/src/external-thread-execution.ts` 持有外部 Thread 的执行状态。请求接纳、原生开始、请求拒绝／取消／完成、Session 活动和故障、恢复及释放通过转换方法更新；running 与输入 busy 由该模块派生。只读子线程的运行状态来自已有子 Agent 观察，不冒充可写 Session 的活动事件。请求队列和 steering 的占位仍由对应协调器持有。

`HarnessSessionCapabilities.nativeExecutionLifecycle` 是可选的事实报告契约，当前三个相关行为一起启用：

- 请求接纳先占 pending，收到 `turn.started` 后成为 active；先行自主段与待执行输入分别结束。
- `session.activity.changed` 独立更新 Session 活动。只有后台活动时 running 可以为真，但不占输入 busy；Root Result 不代替 Session idle。
- 插话按上述消费事实发布。未声明的 Session 保持接纳即 active、接受时投影，Session 活动事件不改变其运行含义。恢复时重新读取新 Session 的能力并清除旧执行状态。

Pi 的历史会把插入文本保存成新的用户条目。Pi Adapter 因而按“原提问加本轮已接受插入数”校验新用户条目数量，并仍把第一条原提问绑定为当前 Host Turn 的原生身份。

## Fork 与撤销窗口

原生历史可能已经在插入点分轮，而 Desktop 在重新读取前仍把内容显示为一个 Turn。Host Runtime 按 Host Thread ID 在内存中拥有 `steeredTurnIds`，记录插过队的 Host Turn：

- Fork 先解析请求的实际 Checkpoint 边界，再检查该边界的 Host Turn；省略 `lastTurnId` 或使用 `beforeTurnId` 不会绕过保护。
- 对 steered 边界的 Fork，以及该 Thread 的撤销，返回 `-32080` 并要求重新打开 Thread。
- 空闲释放只卸载 Native Session，不等于 Desktop 已读取历史；Session 恢复后继续使用同一组未读标记。
- Desktop 重新读取历史并成功收到 Turn 边界后，只清除实际返回的已结束 Turn 的标记。只读取 Items 或未包含该 Turn 的分页不会解除保护，此时操作继续按已读取的原生 Turn 边界执行。
- 标记不落盘；Host 进程重启后自然消失。

这项保护只覆盖 Desktop 视图与原生历史暂时不一致的窗口，不改变 Fork 或回退的持久化格式。

## 停止后重发退路

- `AppServerHost` 按 Thread 所有权分流 Desktop `turn/steer`，外部 Thread 不会落入官方 Account 查找。
- `ExternalTurnSteering` 在取消前注册指定旧 Turn 的终态等待，再调用现有 `turn.cancel`。取消 acknowledgement 不等于完成。
- 等待旧 Turn 的 Interaction/Item 关闭、终态身份持久化及 Desktop 终态通知写出后，Host 复用普通 `turn/start` 的底层启动函数，分配真实的新 Host Turn ID。
- 同 Thread 的其他 start 和 Harness command 不能抢占替换过程。若原生自主 Turn 已先开始，替换失败，不取消该 Turn。
- 取消与终态等待合计最多 20 秒。超时、Session fault、输出流结束、Host 关闭、显式停止、旧轮失败或持久化失败均不再自动启动新轮。
- 成功回执在当前连接内有界保留，用于 outcome-unknown 重试；不承诺跨 Host 重启的 exactly-once。

普通停止仍调用 Adapter 原来的取消实现。本功能不增加统一强杀策略，也不回滚旧 Turn 已完成的文件修改。

## Renderer 接入

Renderer 在展示输入前调用 `codexhost/thread/steering/inspect`，读取 `official`、`nativeAccepted` 或 `newTurn`。Host 执行和预检读取同一个 Session capability：

- `official` 与 `nativeAccepted` 使用 Desktop 自己的 steer 展示，乐观消息属于当前 Turn。
- `newTurn` 继续使用 `renderer-external-steering.ts` 的停止后重发展示：先走 Desktop 的普通 `startTurn` 占位，再只把本次出站 `turn/start` 转换成 `turn/steer`。
- follower 窗口继续使用 Desktop 原有 owner 转发；失败不暗中重试或入队。

Host 和 Renderer 必须配套发布。只升级 Host、让旧 Renderer 仍按停止后重发方式展示原生插话，不属于支持路径。

### 当前边界

- 公共 Harness 输入只支持文本；图片、空输入和 tool response 在送达前拒绝。
- 当前 Turn 没有确认的 ID 时不猜测目标，也不把过期目标改为另一 Turn 重试。
- 原生接受后不因执行转入下一 Turn 而报告拒绝或再次发送。实际分轮由原生事件与历史决定；Host 不按文本匹配推测归属。
- 声明 `capabilities.steer` 的 Adapter：Pi、Claude Code、Qoder / Qoder CN、OMP、Grok、CodeBuddy / WorkBuddy（≥ 2.143.1）、DeepSeek Harness（正式入口要求 ≥ 0.1.7-rc.1）、Hermes gateway。其余 Adapter（Cursor、OpenCode、Kimi Code、Antigravity、Kiro、Hermes ACP 后备路径等）接受公共命令类型但返回 `unsupported`，因此保持停止后重发。各 Harness 的原生依据和验证层级见各自的 `docs/harnesses/*/…steer*.md`。
- 原生乐观消息结算依据 Codex Desktop **26.915.31945 / build 9922** 的只读 Bundle 核查：`clientId` 等于 `clientUserMessageId` 的 `userMessage` 会结算待定 `steeringUserMessage`。该核查不是运行中 Desktop 实测。

原有跟进消息队列、版本化 Renderer 绑定和服务端队列排除规则不变。

### 手动压缩后的自动执行

Codex Desktop **26.924.22138 / build 11645** 的本地队列在 `turnCompleted` 后自动执行下一条消息前，要求最近一个已完成 Turn 含有 `agentMessage`，或含有 `source: "manual"` 的 `contextCompaction`。这个 `source` 不取自 Item 字段：`item/started` 时，Desktop 用自身 `compactThread`（官方 `thread/compact/start`）之前调用的 `registerPendingManualContextCompaction(threadId)` 登记来判定，未登记即为 `"automatic"`。外部 Harness 的 `/compact` 经 `codexhost/thread/command/execute` 或 `turn/start` 进入 Host 命令 Turn，不经过该登记，而各 Adapter 的压缩 Turn 通常没有 Agent Message，因此压缩期间排队的消息不会自动执行（[#414](https://github.com/BytePioneer-AI/codex-host/issues/414)）。

- Host 按命令目录中的 `invocation: "/compact"` 记录显式手动压缩 Turn，在其 `contextCompaction` 的 `item/started` 之前写出 `codexhost/thread/manual-compaction/started { threadId, turnId }`。其他命令 Turn 与普通 Turn 中的自动压缩均不发送该通知；记录在命令失败或 Turn 完成时清除。
- Desktop Renderer 只把方法在其内置 app-server 通知表中的通知交给 Manager（以及 `addNotificationCallback`），`codexhost/*` 方法在这一步被丢弃；Electron 主进程则会把所有 Host 通知原样以 `{ type: "mcp-notification", hostId, method, params }` 投递到窗口 `message` 事件。因此 `renderer-manual-compaction.ts` 按 Host 连接（本机及 SSH）监听窗口 `message`，只接受本窗口（或无 source）的、`hostId` 与该连接一致的通知。仅对已加载、`modelProvider: "codexhost"` 的外部 Thread，且当前窗口不是 follower 时，调用该 Manager 的 `registerPendingManualContextCompaction(threadId)`。窗口消息按到达顺序逐条分发，该登记在紧接着的 `item/started` 被处理前完成并随即被消费；Item 属于同一个进行中的 Turn，登记产生的占位 Item 会被替换。
- 不调用 `compactThread`，不改变压缩执行或 Harness 语义，也不为压缩 Turn 合成 Agent Message。Desktop 缺少该绑定时不安装，保留原有行为；Desktop 对这条未知通知本身不做处理。
- 仅覆盖投影 `contextCompaction` 的命令 Turn。未投影压缩 Item 的 Harness（如 Kimi），以及只有 `commandExecution` 等无回复的非压缩命令 Turn，仍按 Desktop 规则不自动执行。

## 验证

- `packages/host-runtime/test/external-turn-steering.test.ts`：原生插入不取消、按消息去重、失败释放回执，以及停止后重发的终态等待与失败边界。
- `packages/host-runtime/test/external-thread-execution.test.ts` 与 `app-server-host.native-execution.test.ts`：状态转换顺序、能力声明对照、消费事实先于／晚于回执、跨 Turn 投影及去重。
- `packages/host-runtime/test/app-server-host.native-steering.test.ts`：Desktop 原生插入的 `clientId` 投影、送达方式查询、Fork/撤销窗口和重新读取后放行。
- `packages/protocol-core/test/codex-ui-projector.test.ts`：插入的 `userMessage` 在实时与历史投影中留在所属 Turn。
- `packages/renderer-extension/test/renderer-external-steering*.test.ts`：按送达方式选择 Desktop 展示，并保持 RpcTarget、owner/follower、失败和卸载语义。
- `packages/adapters/pi/test/pi-steer.test.ts`：Pi capability、RPC 参数、非活跃目标、身份计数、数量不符和忙时 start。
- `packages/host-runtime/test/app-server-host.manual-compaction.test.ts`：命令菜单与输入 `/compact` 两条路径在压缩 `item/started` 前恰好发送一次通知，普通 Turn 与非 `/compact` 命令 Turn 的自动压缩均不发送。
- `packages/renderer-extension/test/renderer-manual-compaction.test.ts`：经窗口 `mcp-notification` 消息的外部 Thread 登记，follower、未加载／官方 Thread、其他 Host、其他 frame 与非法消息跳过，缺少 Desktop 绑定、卸载，以及按 Host 连接（含 SSH）安装。

2026-09-24 曾用 Pi 0.85.1 经 `PiAdapter` 实机核对原生插入。2026-10-21 的 Adapter Gate 确认 Claude 的迟到输入在下一 Turn 恰好执行一次，DeepSeek、Qoder、Pi 与 WorkBuddy 国内版的对应样本在当前 Turn 执行一次；没有做 Desktop GUI 实测。类型检查和合成测试不能替代发布前的流式文本、工具运行、交互、连续提交、刷新历史、多窗口与远端连接验收。

### Adapter 实机 Gate

`tools/gate-steer/adapter.real.test.mjs` 默认跳过。先运行 `npm run typecheck` 构建当前 Adapter，再用 `CODEXHOST_STEER_REAL_HARNESSES=pi,claude-code,deepseek-harness,qoder,codebuddy,workbuddy,workbuddy-cn node node_modules/vitest/vitest.mjs run --config tests/vitest.config.js tools/gate-steer/adapter.real.test.mjs` 选择实际安装的 Harness。Gate 使用现有登录与默认 Model；`CODEXHOST_STEER_REAL_MODEL` 可指定原生目录中的 `nativeId` 或完整显示名（Pi 使用 `uino / deepseek-flash`），只传给 Adapter open，不修改用户配置。`CODEXHOST_STEER_REAL_SCENARIOS` 可选择逗号分隔的 `single`、`double`、`near-terminal` 场景，缺省运行全部。Gate 会调用真实模型并留下原生 Session。任务只在临时工作目录执行一个前台 `sleep`，结束后清理该目录。`workbuddy-cn` 测试项使用 macOS 的 `/Applications/WorkBuddy.app` 和既有 `~/.workbuddy` 登录目录，国际版沿用 Adapter 默认发现路径。

每个 Harness 检查单次插入、连续两次插入、工具完成附近插入，以及错误目标、空输入和终态后的拒绝。单次与连续插入检查工具成功完成、同一 Host Turn 回复随机标记、只完成一次，以及原生历史身份仍指向原提问。终态附近场景在原 Turn 完成后继续观察完整的 30 秒，记录标记回复落在哪个 Host Turn 及其原生身份；接受的输入必须恰好回复一次且对应 Turn 成功完成，明确拒绝的输入不得执行。即使后续 Turn 提前完成也观察到窗口结束，以发现重复投递；同时保留窗口后的原生历史，未观察到回复不能据此断言永久丢失。完整事件与结果写入 `.codexhost/native-steer-real/<harness>/`，不把环境阻塞或部分场景通过当作完整验收。
