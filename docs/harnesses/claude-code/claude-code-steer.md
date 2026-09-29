# Claude Code 原生插话与执行生命周期

Claude Code 使用一个常驻 Agent SDK Query。输入的提交、原生接收和实际执行是不同事实；输入不会替换正在运行的工具解析状态。Transport 统一发布带输入 ID、执行段 ID 的原生事件，Session 决定它们对应的 Host Turn。

## 输入与执行归属

普通 start 在已观测到原生执行时返回 busy；尚未观测到先行自主段的窗口里，已提交输入以 `priority: "later"` 排队。Host 保留接纳中的请求，实际执行指针由 `turn.started` 更新。因此自主段 A 可以正常输出和结束，待执行输入 B 不会接收 A 的事件。

steer 使用 `priority: "next"` 和 `origin: { kind: "human" }`。`command_lifecycle queued` 确认原生已接收，Host 返回 `nativeAccepted`，不承诺同轮执行；`started` 可能在当前执行段内发生，也可能在下一段之前发生。Adapter 按真实消费位置发布 `userMessage` Item，保留 Desktop 的客户端消息 ID；Host 看到 `inputProjection: "adapter"` 后不重复投影；顺延到下一 Turn 时也只发布一次输入 Item。

旧 Result 不撤销已提交输入，也不清除尚待到达的接受回执。10 秒未确认时报告“输入仍可能执行”，不自动重发。Result 中的输入 UUID 不用于重新归属已经交付的输出。

## 执行段、空闲和后台任务

每个原生主段只有一个 accumulator，工具开始与返回由它持续配对，Result 后释放。root init 建立段；嵌套 init 不启动主段。自主段的首个执行输出才建立可见 Turn；仅有 init 和成功 Result、没有用户输入或实际输出的空段不创建空 Turn。失败和交互仍正常呈现。

开启 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 后，原生 `session_state_changed` 提供 running、requires_action、idle。Adapter 要求初始化提供 Session 活动状态，并在 init 上检查 `msg_lifecycle_v1` 能力；不再用 held 或静默计时器判断续跑结束。Host 分别维护待开始的请求、当前执行和原生活动状态。

后台 Agent/Bash 和 Workflow 运行的任务寿命独立于主段。原生 idle 不意味着后台 Bash 已停止；后台事件和进程保活继续由任务事实驱动。Workflow 进度是会话级事实，已转入后台的运行在其回合结束后继续报告智能体状态。取消活动回合时，中断主段之外还显式停止本回合启动的后台 Agent 与 Workflow，并等原生确认任务结束；未确认时关闭进程。原生 Tool 调用 ID 同时用于实时和历史 Tool Item 身份，避免自主段尚未取得持久输入 ID 时生成不一致的工具标识。

权限控制回调可能先于消息迭代器消费 ToolUse。Transport 将已有待响应请求按 `toolUseID` 与本段工具关联；嵌套请求依据父调用关联，Workflow 智能体的请求依据其所属 Workflow 调用关联。没有存活父执行的嵌套请求明确拒绝。AbortSignal、段结束和 Session 关闭负责结算请求，不另设权限等待计时器。

## 取消与关闭

取消待开始的输入使用原生 `cancel_async_message`，依原生回执及输入生命周期结算。取消当前 Turn 会撤回提交给该 Turn、尚未消费的 steer，再中断对应原生段；其他已接纳输入继续保留。`interrupt()` 的 survivors 不能被当成已取消，未知回执也不推定队列为空。

SDK 公开 Query 缺少逐输入撤回和带清队列参数的中断。Transport 通过自己拥有的 spawn hook 管道集中发送这两种原生控制请求，用独立请求 ID 关联回执，不访问 SDK 私有方法。Session 关闭时，在原生声明支持的情况下中断并清队列，然后停止后台任务、关闭 Query 并确认进程退出；单个 Turn 取消不通过关闭整个 Session 来撤回另一条输入。

接纳后的输入也可能在真正开始前取消或失败；Host 可完成该待执行请求，不伪造执行开始事件。执行段取消与 Session 故障分别处理。

## 原生身份与历史

临时执行段 ID、Host Turn ID、Native Turn Ref 和 Assistant checkpoint 各有用途。自主输出缺少输入 UUID 时，按本段实际 Assistant checkpoint 截取 transcript，复用历史分组确定真实输入；落盘稍晚时使用有界读取重试，不能取任意“最新输入”或伪造原生身份。

历史保留 `queued_command` 附件：同轮 steer 的 `source_uuid` 恢复为所属段内的用户输入；运行中吸收的任务通知不拆轮。另起执行的通知输入只有产生实际助手输出才形成历史 Turn。成功空段不产生持久化记录，缺少原生 Result 证据的历史终态仍标为未知。

## 验证范围

原生时序实测版本为 Claude Code 2.1.283、Agent SDK 0.3.220、macOS。现有 Transport、Adapter、历史和 Host 测试覆盖归属、审批、取消、空段及重读；Broker 测试核对跨进程事件和消息 ID。隔离 CLI 验证使用本地固定响应服务，覆盖先行自主段、steer 和排队撤回，不调用云端模型或重启日常 Desktop。
