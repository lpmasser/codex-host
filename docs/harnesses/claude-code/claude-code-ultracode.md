# Claude Code Ultracode 与 Workflow 子智能体

Claude Code 从 2.1.154 起提供会话级的 Ultracode：开启后 Claude 会持续用 Workflow 工具把任务拆给多个子智能体并行完成。codexhost 在 Claude 的思考档位菜单中提供 **Ultracode**，并把 Workflow 派出的智能体显示为可点开的子智能体。

## 用户可见行为

### 档位

- 档位菜单在 Max 之后新增 **Ultracode**，所有模型都会显示。它的含义固定为原生 effort `xhigh` 加会话级 `ultracode`，在 Claude Code 2.1.284 前后两种原生语义下行为一致。
- Ultracode 需要同时满足三个条件：Claude Code 2.1.154 及以上；Dynamic workflows 已打开（Claude Pro 默认关闭，在 Claude Code 中运行 `/config` 打开，或在 `~/.claude/settings.json` 中设置 `"enableWorkflows": true`）；当前模型支持 Ultracode。codexhost 不会替用户打开 Workflows。
- Ultracode 会明显增加额度消耗，请按需选择。

### 未生效时不降级

Claude Code 对 Ultracode 请求一律"接受"，不可用时也不报错，旧版本还会把它当作不认识的设置悄悄合并。codexhost 因此在每次进入 Ultracode 后读回原生会话设置，只有 Claude Code 报告 Ultracode 已生效才继续：

| 时机 | 未生效时的表现 |
|---|---|
| 选择 Ultracode 后发送消息 | 消息不发送给 Claude，直接显示原因；档位仍为 Ultracode，满足条件或改档位后重发即可 |
| 会话中切换到 Ultracode | 显示原因，档位保持原来的选项 |
| Ultracode 下切换模型 | 显示原因，撤回模型切换，保持原模型与 Ultracode |

会话中切换被拒绝时，模型按钮上方会弹出提示，标题为"无法切换模型"或"无法切换思考选项"，正文是 Claude Code 给出的原因；按钮旁显示红色标记，直到下一次切换成功。提示约 8 秒后自动消失，鼠标停在上面时不消失，点击或按 Esc 可关闭。

原因提示：

- Claude Code 版本过旧：提示升级到 2.1.154 或更高版本。
- Workflows 已明确关闭：提示在 `/config` 打开 Dynamic workflows。
- Workflows 已明确打开但仍不可用：提示当前模型不支持 Ultracode。
- 无法判断具体原因（例如 Workflows 使用套餐默认值）：同时提示打开 Dynamic workflows 并使用支持 Ultracode 的模型。

撤回模型或档位本身失败时，原生状态已无法确定，会话会进入故障态，需要重新打开。

### Workflow 子智能体

Ultracode 下（以及提示中出现 "ultracode" 关键词时），Claude 会调用 Workflow 工具。codexhost 的显示方式：

- Workflow 运行前的权限请求显示 Claude Code 提供的 Workflow 描述，不显示脚本。
- 一次 Workflow 运行显示为一张协作智能体卡片，说明为 Workflow 描述；每个智能体是卡片中的一个子智能体，显示标签、阶段、模型与状态（排队、运行、完成、失败），完成或失败时附带结果或错误摘要。
- 智能体开始运行后即可点开为只读子线程，首条提示为该智能体收到的任务原文。智能体调用工具或状态变化时，已打开的子线程会刷新。
- Workflow 转入后台后与后台 Agent 子智能体相同：回合随主回复结束而完成，委派 Item 独立存活到原生任务结束。后来才出现的智能体继续加入原 Item，并注册可打开的子线程。后台运行不占用输入，期间可以直接发送新消息；Claude 之后实际开始的汇总主段显示为自主回合。
- 智能体需要权限时，审批标题前带智能体标签，例如 `count:a.txt: Bash`。审批和问题跟随原生任务寿命，主回复结束后仍可作答；原生撤销或任务/会话结束时关闭。请求的 Host/Desktop 映射和验证边界见[执行生命周期](claude-code-steer.md)。
- 取消活动回合时，codexhost 停止本回合已取得原生任务 ID 的后台任务并中断主段，任务收到原生停止终态才标记中断。原回合已完成时也可经现有取消入口停止这些后台任务，不中断另一个主回合；取消期间新启动且已取得 ID 的任务同样停止。缺少任务 ID 时不能保证定向停止；已发出的停止请求得不到确认时关闭进程。Claude 对停止通知自行开始的回复按原生事实显示为自主回合。

## 所有权与投影

- `packages/adapters/claude-code/src/thinking-options.ts`：Ultracode 档位，以及按切换方向生成 `applyFlagSettings` 载荷。只有进入或离开 Ultracode 时才带 `ultracode` 键，离开时显式写 `ultracode: false`，因为关闭 Thinking 或保持 xhigh 都不会清除已请求的 Ultracode。
- `packages/adapters/claude-code/src/ultracode.ts`：读回判定（只认 `applied.ultracode === true`，其余一律按未生效）、原因分类与错误映射。读回使用 SDK 已实现但未写入公开类型的 `Query.getSettings()`。
- `packages/adapters/claude-code/src/sdk-transport.ts`：启动时在写入用户消息前确认 Ultracode；会话中切换与换模型时确认，失败时恢复并读回确认。提供 `stopTasks`（停止并等待确认）。Workflow 进度与智能体交互作为会话级事实发送，不开启主段；原生任务结束先关闭所属请求，再投递任务终态。
- `packages/adapters/claude-code/src/native-message.ts`：识别 `Workflow` 工具、`local_workflow` 任务帧与 SDK 未公开的 `task_progress.workflow_progress`。主回合结束后的进度帧由新的累积器处理，带 `workflow_progress` 的帧自带身份，其余按调用 ID 交给 Adapter 匹配。
- `packages/adapters/claude-code/src/workflow-lifecycle.ts`：一次运行对应一个子智能体委派项。智能体按序号维护，`subagentId` 为“调用 ID:序号”，拿到原生 `agentId` 后成为 `nativeSubagentId`，Host 据此注册子线程。Session 持有运行及原回合归属：后台启动时脱离主回合，之后以 `item.updated` 报告包括迟到智能体在内的状态，由 `task_notification` 完成 Item；会话或进程结束时一并结算。
- `packages/adapters/claude-code/src/claude-code-adapter.ts`：错误映射；取消回合时停止并确认本回合的后台子智能体与 Workflow，再中断主段，停止未确认时关闭进程。
- `packages/renderer-extension/src/renderer-model-picker.ts`、`renderer-model-selection-notice.ts`：切换被 Host 拒绝时的失败标记与提示；`renderer-binding-probe.ts` 只在模型或档位切换被拒绝时给视图加 `selectionRejected` 与递增的 `selectionErrorId`。
- `packages/adapters/claude-code/src/claude-history.ts`：子线程首条提示去掉 "[Workflow harness — computed task]" 外层包装与缩进；无法识别时原样显示。Ultracode 下任务前那条转述用户请求的 "[Workflow harness — user request]" 提示不显示。

子线程转录通过官方 `getSubagentMessages()` 读取，路径为 `<session>/subagents/workflows/<runId>/agent-<agentId>.jsonl`。SDK 0.3.220 读取这类转录时会在附件记录处断链，只能得到最后几条消息，因此依赖升级到 0.3.273（0.3.259 起修复）。

## 已知限制

- `get_settings` 与 `workflow_progress` 不是公开接口，Claude Code 升级后可能变化。读回失败时会按未生效处理并提示；进度项中无法识别的内容会被忽略。
- Codex 的协作智能体卡片只显示状态与摘要，不显示阶段分组、用量与运行日志；不支持单独停止或续跑某个智能体。
- 冷读取历史（例如重启后重新打开会话）时，Workflow 与现有 Agent 子智能体一样显示为普通工具项；运行时已创建的子线程仍可打开。
- 不提供独立于档位的 Ultracode 开关（例如 High + Ultracode）。
- 主段结束后的卡片更新、任务审批与非阻塞问题已由跨层契约测试覆盖，尚未用本次实现进行真实 Desktop/Workflow 验收。

## 验证

以下实机记录来自挂起回合的实现；当前独立任务生命周期、后台审批与取消按上文行为，仅有定向回归覆盖，不能据此宣称新映射已经通过 GUI 验收。

已在 Linux x64 上用 Claude Code 2.1.287 实测：Workflows 关闭时发送消息被中止且未调用模型；`CLAUDE_CODE_WORKFLOWS=1` 时完整运行一次两个智能体的 Workflow（审批、卡片状态、主回复结束后作答智能体审批、汇总后完成、子线程首条任务）；会话中切换到 Ultracode、Ultracode 下换模型被拒并撤回。另用 Claude Code 2.1.153 确认旧版本提示升级。2.1.154–2.1.283 区间未实机验证。

另在 Codex Desktop（Windows 10，通过 SSH Remote Host 连接 Linux，Claude Code 2.1.289）上实测：档位菜单与 Workflows 关闭时的报错、Workflow 卡片与子线程、智能体审批、挂起期间的取消与发新消息、拒绝 Workflow 审批、Ultracode 下切换到 Haiku 被拒绝时的提示。

定向回归：

```sh
npx vitest run --config tests/vitest.config.js \
  packages/adapters/claude-code/test/ultracode.test.ts \
  packages/adapters/claude-code/test/workflow-lifecycle.test.ts \
  packages/adapters/claude-code/test/native-message.test.ts \
  packages/adapters/claude-code/test/sdk-transport.test.ts \
  packages/adapters/claude-code/test/claude-code-adapter.test.ts \
  packages/adapters/claude-code/test/claude-history.test.ts
```
