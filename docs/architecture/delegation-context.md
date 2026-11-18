# 委派发送者链接与进行中消息读取

CLI 使用外部 Harness 的 `CODEXHOST_THREAD_ID` 或原生 Codex 的 `CODEX_THREAD_ID` 识别调用方。在 `delegate start` 的任务和 `thread send` 的消息末尾追加 `Sender: codex://threads/<id>`；缺少调用方时正文不变。接收者自行决定是否通过 `thread read <link> --view messages` 读取来源，不会自动注入来源对话。显式 `--parent-thread` 只指定创建关系，不能改变实际发送者；后续消息也不沿用最初父会话冒充发送者。

`thread read --view messages` 复用 Host 的可见 Turn 投影，包括普通 Desktop 会话正在执行的用户输入。读取使用投影器的 `snapshotInput` / `snapshotTurn` 完整快照，完成后的内存历史由快照路径保留输入；Desktop wire 投影独立处理已有的乐观消息，不重复发布初始输入。当前轮和历史投影使用相同的用户消息 ID，完成后输入不会从消息序列中消失再出现。按 Turn 读取，默认最近 10 轮，最多 50 轮；`--from` / `--to` 为从 1 开始的绝对轮号；读取不改变线程状态、不返回工具输出或私有推理，也不绕过原生可见范围。原生 Codex 继续由官方 `thread/read` 提供可见消息。
