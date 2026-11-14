# Antigravity Transcript、压缩与用量投影

Antigravity CLI 的 `stream-json` 提供运行中的步骤和终态，但部分工具只有精简参数、结果摘要。Adapter 用绑定 Profile 的原生 Transcript 补齐实际工具详情；Host 负责把这些事实展示到 Desktop。两层都不重建工具执行或上下文压缩。

## 工具详情与已应用补丁

当前 `agy 1.2.14` 原生日志将调用参数写在 `PLANNER_RESPONSE.tool_calls`，执行结果写在对应 `GENERIC` 步骤。Adapter 按原生执行 step index 和工具名关联调用及结果，解码各参数的 JSON 表示；不按文件名寻找“最近一次编辑”；工具详情不读取、不夹带内部 thinking。日志读取限制在所绑定 Profile 的 conversation 目录，拒绝重定向到目录外的文件，并限制读取大小。

精简的 stream 事件继续驱动生命周期。终态工具步骤补取原生参数和输出，命令调用保留原生命令输出，其他工具保存完整参数与受现有输出长度限制的结果。日志未生成、尚未完成或不可读时，保留已有 stream 事实，不把工具判成失败，也不伪造缺少的数据。

`replace_file_content` 等工具结果中的 `[diff_block_start]` / `[diff_block_end]` 保存的是已经应用的原生补丁。Adapter 保留其 hunk 行号和内容，将其投影为 `fileChange`；只展示成功执行的已应用补丁。没有补丁的调用仍是工具详情，例如原生只给创建确认、未提供已应用 diff 的 `write_to_file`。不会把请求的替换文本、当前磁盘内容或累计工作区 Git diff 当成该次调用的真实补丁。

## 探索活动与原生展示

探索类工具（`view_file`、`list_dir`、`grep_search`）保留真实参数和原生输出，由 Adapter 从 `AbsolutePath`、`DirectoryPath`、`Query` / `SearchPath` 生成规范化 activity（`read`、`listFiles`、`search`），Core 将其投影为 `commandExecution` 及原生 `commandActions`。路径和查询不裁剪，查询中的空格和引号保留原义。Codex Desktop 据此进行原生探索统计与展示；无实际进程的调用保持 `processId` 与 `exitCode` 为 null。缺少必要路径或查询时继续保留为通用 Tool Item。侧车读取时统一依据原工具名和参数派生 activity，不重写历史文件；新快照正常持久化 activity 字段。

## 压缩事件与上下文用量

主会话原生 `checkpoint` 的 `contextCompaction` 生命周期与手动 `/compact` 命令沿用上游 Adapter；压缩结束触发原生上下文读数刷新。Subagent Transcript 的 CHECKPOINT 保留为压缩 Item，不消耗待关联的工具调用。Host 不自建压缩机制。

input/output/thinking/total token 保留原生用量语义：步骤数据描述对应生成，result 数据汇总用量。当前上下文占用以 Language Server 的原生上下文读数为准，不由累计输入推算；本轮尚无该读数时，才以单次请求的 `input_tokens` 加 `cache_read_tokens` 作为后备，result 的会话累计用量不作为上下文。读取最新有效的 contextWindowMetadata，生成完成、压缩及本轮结束重新读取；旧异步查询不能覆盖更新结果。刷新保持一个在途读取，并合并期间的新触发，过程读取不为每个文本 delta 发请求；失败不会把累计 token 冒充为当前上下文。

普通工具详情沿用现有 Desktop 的会话状态，按行 React props 中的 Thread ID 与 Item ID 匹配原始 `dynamicToolCall`。点击或键盘展开参数、输出和状态；打开的运行中调用订阅现有会话回调，到终态、关闭或实例释放时退订。每个 Host binding 只释放自己创建的面板和行属性，已有原生子控件保持其行为。该适配依赖 Desktop 26.928 的私有行 props 与 manager 方法；没有新增 RPC，也没有复制一套会话状态。

## 终态与验证边界

本轮终态判定沿用 Adapter 既有规则，本投影不改变它，也不自动重发整轮任务。

回归覆盖精简 stream → Profile Transcript → 完整工具 Item / 已应用 diff → 历史快照，并用原生故障会话的三次实际编辑记录核对补丁可由 Git 解析。模拟 CLI 与 Language Server 验证压缩及上下文增长、下降和终态刷新；这些检查不代替真实 Desktop GUI 或服务端网络稳定性验证。修复不改写已有旧历史中的缺失工具数据。
