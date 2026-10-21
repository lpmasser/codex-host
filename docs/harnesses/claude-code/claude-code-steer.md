# Claude Code 原生插话

Claude Code 的运行中插入走 Agent SDK 流式输入：向当前 Query 的输入流推入 `SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。这不会取消当前 Turn；原生可以把迟到输入留到紧接着的下一 Turn。`now` 会打断，`later` 会等到空闲，Adapter 都不用。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。

## 接受

CLI 先发 `command_lifecycle` `queued`，表示 Claude 已接受并负责将这条输入执行一次；`started` 标记原生开始处理，不保证它仍属于提交时的 Turn。Adapter 在 `queued` 时返回 `{ accepted: true }`，Host 报 `nativeAccepted`：此后由 Claude 负责送达，不等 `started`，否则调用方要被整段工具调用挂住（Desktop 提交约 30 秒超时）。若本轮在插入前结束，Claude 会把已排队的输入作为下一次运行执行，由现有自主 Turn 路径呈现。`queued` 之前 Turn 的 `result` 先到，或会话已关闭、目标不是当前 Turn，返回 `invalidState`。空文本返回 `invalidRequest`。忙时 `turn.start` 仍是 `sessionBusy`。

## 版本

2026-09-24 在本机 Claude Code 2.1.280 上实机确认。没有查到 `priority: "next"` 的更早引入版本，因此不设版本门槛，已安装的 Claude Code 都声明 `capabilities.steer`。

## 历史

原生并入当前执行的输入可以保存为 `queued_command` attachment；现有历史解析不把 attachment 当作新的 user 行。迟到后另行执行的输入可以保存为普通 user 消息，刷新后据此形成下一历史 Turn。实时后续 Turn 的 input 为空时，不再重复发布 Host 已显示的接受消息；这不会删除原生历史中的输入。

## 验证

实机：模型 `haiku`，权限 `bypassPermissions`，一轮里调用 Bash 执行 `sleep 4; echo tool-done`，工具开始后以 `priority: "next"` 插入一句。流里只有一次 `result`（`subtype: "success"`，`terminal_reason: "completed"`）。`started` 出现在工具结果之后、下一次模型请求之前，模型回复提到了插入的句子。因此实时结果处理不改：纯文本 user 回显本来就被忽略，第一个 `result` 仍是本轮结束。

2026-10-21，Claude Code 2.1.293 的 near-terminal Gate 中，已接受输入在紧接的自主 Turn 完成一次。原 Turn 完成后继续观察 30 秒，没有重复回复；历史包含下一 Turn 的实际 user 输入。Host 投影测试覆盖实时只显示一次、刷新后按原生分轮读取。
