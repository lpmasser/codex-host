# 委派父关系与独立任务

`delegate start` 可以在没有父会话的普通终端中创建独立任务，仍需已有 Runtime 连接和权限。父关系优先使用显式 `--parent-thread`，其次使用 CLI 调用方的 `CODEXHOST_THREAD_ID` 或原生 `CODEX_THREAD_ID`；缺少这些身份时任务没有父会话。Host 不从活跃 Turn 或自身进程环境推断父关系。外部 client 沿用 `client:<name>` 来源身份，创建时仍须提供 `--cwd`。

`--cwd` 优先；有父会话时继承其目录，否则沿用 Runtime 的工作目录。无父任务位于会话树根部。子会话标题仅使用子任务名，见[委派子会话命名](delegation-titles.md)。空白任务在 CLI 发起 Runtime 请求或创建 worktree 前被拒绝。

创建路由在已有 Runtime 内选择：无父时，原生 Codex 和外部 Harness 均优先使用已注册的共享 catalog；没有共享 catalog 时使用唯一注册会话。没有共享 catalog 且注册项不唯一时明确报歧义，不按活跃任务数量选择或自动发现其他 Host。显式父关系继续按已有的 Thread 归属检查路由到拥有者。无父的 `delegate start --watch true` 保留创建结果并报告 `notRegistered`，可用 `thread watch --notify` 明确选择接收方。

去重比较父关系、目标 Harness 和 `taskDigest`；摘要包含任务正文、解析后的 cwd、model ID 与 thinking option ID。有父任务按这些键进行短时间去重。无父任务只使用显式 `--request-id` 去重，避免把不相关终端的相同任务合并。同一请求 ID 改变上述任一键会被拒绝。

委派记录 V1 的 `parentHostThreadId` 和 `sourceHarnessId` 可省略，原有有父记录无需迁移。旧版本仍要求这两个字段：降级时会隔离无父委派记录，丢失这些任务的请求 ID 去重和委派状态记录；隔离会将文件从 `delegations/` 重命名移入 `quarantine/`，升回新版不会自动恢复。任务的 Thread 记录及原生会话不受影响。

CLI 使用外部 Harness 的 `CODEXHOST_THREAD_ID` 或原生 Codex 的 `CODEX_THREAD_ID` 识别调用方。在 `delegate start` 的任务和 `thread send` 的消息末尾追加 `Sender: codex://threads/<id>`；缺少调用方时正文不变。接收者自行决定是否通过 `thread read <link> --view messages` 读取来源，不会自动注入来源对话。显式 `--parent-thread` 只指定创建关系，不能改变实际发送者；后续消息也不沿用最初父会话冒充发送者。

`thread read --view messages` 复用 Host 的可见 Turn 投影，包括普通 Desktop 会话正在执行的用户输入。读取使用投影器的 `snapshotInput` / `snapshotTurn` 完整快照，完成后的内存历史由快照路径保留输入；Desktop wire 投影独立处理已有的乐观消息，不重复发布初始输入。当前轮和历史投影使用相同的用户消息 ID，完成后输入不会从消息序列中消失再出现。按 Turn 读取，默认最近 10 轮，最多 50 轮；`--from` / `--to` 为从 1 开始的绝对轮号；读取不改变线程状态、不返回工具输出或私有推理，也不绕过原生可见范围。原生 Codex 继续由官方 `thread/read` 提供可见消息。
