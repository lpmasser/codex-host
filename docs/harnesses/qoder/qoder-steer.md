# Qoder 原生插话

Qoder 与 Qoder CN 共用同一套会话实现。插入走 `@qoder-ai/qoder-agent-sdk` / `@qodercn-ai/qodercn-agent-sdk` 1.0.39 的流式输入：`SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。SDK 注释写明 `next` 在安全边界插入，`now` 打断当前 Turn，`later` 等到空闲。Adapter 只用 `next`。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。现有解析把带文本的 human user 消息当作新一轮的起点。原生保存为 user 行的输入，刷新后按该行分轮；不强制合并回提交时的 Turn。

## 接受

与 Claude Code 相同，依据是 SDK 的 `command_lifecycle`。`queued` 表示 Qoder 已接受这条输入，此时返回 `{ accepted: true }`，Host 报 `nativeAccepted`；`started` 表示原生开始处理，可能在当前或紧接的下一 Turn。接受后由原生负责执行一次，Host 不重发。`queued` 之前 Turn 的 `result` 先到，或会话已关闭、目标不是当前 Turn，返回 `invalidState`。空文本返回 `invalidRequest`。忙时 `turn.start` 仍是 `sessionBusy`。

## 版本与验证

没有查到更早的引入版本，不设版本门槛。能力依据是 SDK 1.0.39 的 `priority: "next"` 和 `command_lifecycle` 接受事件，不把 Claude 的执行分轮推定为 Qoder 的保证。

2026-10-21 在 Qoder CLI 1.1.63 上完成 Adapter 实测：单次、连续两次与 near-terminal 样本通过，后者在原 Turn 完成一次，30 秒内无重复。该样本未触发下一 Turn 执行，不据此声称已验证 Qoder 的所有跨 Turn 投影路径。
