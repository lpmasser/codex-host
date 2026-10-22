# 委派来源与当前对话读取

`delegate start` 可以在没有父会话的普通终端中创建独立任务，仍需已有 Runtime 连接和权限。`--cwd` 优先；有父会话时继承其目录，否则沿用 Runtime 的工作目录。无父创建不根据活跃任务或 Host 进程环境推断来源。

CLI 使用外部 Harness 的 `CODEXHOST_THREAD_ID` 或原生 Codex 的 `CODEX_THREAD_ID` 识别调用方。在 `delegate start` 的任务和 `thread send` 的消息末尾追加 `Sender: codex://threads/<id>`；缺少调用方时正文不变。接收者自行决定是否通过 `thread read <link> --view messages` 读取来源，不会自动注入来源对话。显式 `--parent-thread` 只指定创建关系，不能改变实际发送者；后续消息也不沿用最初父会话冒充发送者。

创建路由在已有 Runtime 内选择：无父时使用唯一注册会话，外部 Harness 可使用已注册的 shared owner；存在多个原生 Codex 会话且无法确定承接者时明确报歧义，不随机选择或自动发现其他 Host。显式父关系仍路由到它的拥有者。watch 的内部消息不经过 CLI 来源装饰；无父的 `delegate start --watch true` 保留创建结果并报告 `notRegistered`，可用 `thread watch --notify` 明确选择接收方。

有父任务沿用短时间内按父、目标、任务和配置的去重。无父任务只使用显式 `--request-id` 去重，避免把不相关终端的相同任务合并。来源行是实际任务文本的一部分；同一请求 ID 改变发送者或父关系会被拒绝。

`thread read --view messages` 复用 Host 的可见 Turn 投影，包括普通 Desktop 会话正在执行的用户输入。读取沿用上游 `snapshotInput` / `snapshotTurn` 完整快照，完成后的内存历史也由上游快照路径保留输入；Desktop wire 投影独立处理已有的乐观消息，不重复发布初始输入。当前轮和历史投影使用相同的用户消息 ID，完成后输入不会从消息序列中消失再出现。按 Turn 读取，默认最近 10 轮，最多 50 轮；`--from` / `--to` 为从 1 开始的绝对轮号；读取不改变线程状态、不返回工具输出或私有推理，也不绕过原生可见范围。原生 Codex 继续由官方 `thread/read` 提供可见消息。

委派记录 V1 的 `parentHostThreadId` 和 `sourceHarnessId` 可省略，原有有父记录无需迁移。旧版本仍要求这两个字段：降级时会隔离无父委派记录，丢失这些任务的请求 ID 去重和委派状态记录；任务的 Thread 记录及原生会话不受影响。
