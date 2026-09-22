# Antigravity Account Profiles

在 Accounts 设置页导入 Antigravity Manager 普通导出的账号 JSON：

```json
[
  { "email": "first@example.com", "refresh_token": "..." },
  { "email": "second@example.com", "refresh_token": "..." }
]
```

文件仅导入本机，支持新增和同账号重新导入。账号登录、重新授权仍在 Manager 中完成。codexhost 不提供登录、切换、删除账号或额度调度界面。导入文件上限 1 MiB、最多 100 个条目；重复邮箱但凭据冲突的条目明确失败。结果只显示账号标签和固定原因，不显示 token 或原始认证异常。

## 所有者与生命周期

- Antigravity Adapter 拥有导入、OAuth 初始化、Profile 索引及运行环境。Host 通过公共 `HarnessAccountProfiles` 契约调用，不解析 Google 凭据。
- `mapping-store` 的 Thread 记录保存唯一的 `accountProfileId`。新 Thread 轮询选择，随 provisional 记录落盘后才 open；后续 Turn、resume、fork、rollback 与原生 subagent 继承该绑定。独立委派 Thread 按新建规则分配。
- 外部 Harness 的 `delegate start --request-id` 对同一请求串行协调，重复请求以及仅遗留 provisional 的崩溃重试复用原 Thread 和 Profile。不同请求仍并行；原生 Codex 直接走官方路径，不进入此队列。Desktop 的每次独立 `thread/start` 创建新 Thread，不将连接内 JSON-RPC 序号当作持久幂等键。
- 没有 Profile 字段的历史 Thread 保持默认账号路径。已绑定 Profile 缺失、凭据缺失或不可用时失败，不回退默认账号、不换号。
- 重新导入按已验证的邮箱保留 Profile ID。活动 Turn（含原生子任务收尾）、open/派生与认证检查持有 Profile 租约；使用中拒绝重导入。单个账号初始化失败保留原文件，其他账号继续处理。

Profile 存在 `CODEXHOST_DATA_DIR/antigravity-profiles`，默认在 Host 自己的 `~/.codexhost` 下。索引只保存 ID 和邮箱；每个 Profile 的私有 HOME 保存原生凭据。新账号先完成临时目录，通过 rename 发布目录，最后原子写入索引；凭据文件 `0600`，私有目录 `0700`。已有账号通过临时文件与 rename 替换凭据。运行中的 token 刷新由 AGY 负责，没有 Host 定时刷新器，也不回写或监听 Manager 的导出文件。

## 原生认证边界

导入沿 AGM 的 refresh-token grant 和 userinfo 请求语义完成初始化，支持其内置个人 OAuth client，不猜测自定义 client，不处理 enterprise/WIF 项目导出。导出邮箱与授权真实邮箱必须一致。原生文件是 `codeassistclient.StoredToken`：外层必须写入 `auth_method: "consumer"`，CLI 的 `getOauthParams` 用它选择个人 OAuth 配置；语言服务器的 AuthMode 推导不能代替这个字段。`token` 为嵌套 OAuth2 对象，包含 `access_token`、`token_type`、`refresh_token`、RFC3339 `expiry`；返回 `id_token` 时保存到外层。个人账号不写入企业、WIF 或项目字段。

CAAM 提供 shallow HOME 的布局依据：认证文件私有，Git、SSH、MCP、Skill 等开发配置及非认证状态共享。`.gemini`、`antigravity-cli` 及其认证缓存目录是真实目录；不将原账号的 OAuth 文件、钥匙串回退标记或旧 `jetski-standalone-oauth-token` 链接进 Profile。Host 数据目录位于 HOME 的深层目录时，仅隔开 Profile 子树，保留 Library 等其他配置。共享历史并非安全沙箱，不能隔离同一 OS 用户对其他文件的访问。

当前 CLI 的 `auth.NewCLITokenStorage` 用传入的数据目录与 `<provider>-oauth-token` 动态拼接文件名，Antigravity Profile 的目标为 `.gemini/antigravity-cli/antigravity-oauth-token`。`codeassistclient.NewFileTokenStorage` 的 `~/.gemini/jetski-standalone-oauth-token` 是另一条通用库路径，不能替代 CLI 的存储目标；仅搜索二进制中的完整文件名不能证明动态拼接的路径不存在。

macOS 的原生 composite storage 默认可访问系统 Keychain，改 HOME 本身不够。Profile 进程显式设置 HOME/GEMINI_HOME（Windows 同时设置 USERPROFILE），并使用进程内 `SSH_CLIENT="127.0.0.1 0 0"` 命中当前 AGY 的原生 SSH/headless 纯文件分支：构造时缓存选择，Load 与 Save 使用同一个选择。不会建立 SSH 连接，不修改系统钥匙串。该环境标记会被 AGY 的工具子进程继承，依赖 SSH 环境检测的用户脚本会看到它；这是当前原生认证接口的适配约束。

不使用临时 keyring timeout marker 实现隔离：原生 marker 一小时后过期。也不把固定 access token 注入环境来代替原生刷新。会绕过 Profile 的 `JETSKI_OAUTH_TOKEN`、`AGY_ADC_AUTH` 和已知原生数据目录覆盖变量在 Profile 子进程环境中移除；Host 自身的环境不修改。

## 模型与额度

模型检查缓存按 Profile 和工作目录区分。无 Thread 上下文的模型目录使用第一个已导入 Profile，不推进轮询；这样只导入账号、没有默认登录时仍能选模型。真正 open 使用绑定 Profile 的目录；模型执行和原生校验使用同一 Profile，旧默认 Thread 仍检查默认环境。

没有明确账号上下文的全局额度展示，在存在导入 Profile 时返回空，不把默认账号或最后一次查询冒充所有账号。原生会话内的命令仍使用该会话的 Profile。首版没有多账号额度看板。

## 实现与证据

- `packages/adapters/antigravity/src/account-profiles.ts`：Profile、导入发布、轮询与租约。
- `packages/adapters/antigravity/src/agm-credentials.ts`：AGM OAuth 初始化与原生文件编码。
- `packages/host-runtime/src/account-profiles.ts`、`packages/shared-contracts/src/account-profiles.ts`：元数据响应与文件导入契约。
- `packages/renderer-extension/src/settings/account-profile-import.ts`：本地文件选择和结果展示；Renderer 固定使用本地 Host，managed remote 插件不暴露导入能力。
- `account-profiles.test.ts`、`agm-credentials.test.ts`、`profile-lifecycle.test.ts`：临时目录、模拟 OAuth 和替身进程测试；Host/mapping-store 的 `account-profile*.test.ts` 覆盖绑定、恢复、派生与幂等。浏览器用例在 `tests/e2e/renderer-settings-accounts.spec.ts`，使用模拟客户端。

认证布局参考 CAAM `56135bec639c3dacc666e2c1cc1888386c3e3a16` 的 `internal/shallow/shallow.go`；OAuth 请求依据 AGM `85e7f83aec74dffb79abd31b6af53192c4958c2f` 的 `src-tauri/src/modules/oauth.rs`。这里实现协议互操作，没有移植其完整源码或引入常驻依赖。

2026-09-22 原生静态核对对象是本机 macOS arm64 AGY，SHA-256 `62913fb38f14d376e67b62014e701063f4061aba60b0e049cb6af9cab62763ef`。首次交付仅有静态及模拟验证。用户随后完成真实导入，实测模型探测失败，日志为 `Unknown auth method:`（空值），暴露导入器遗漏 `auth_method` 的缺陷；补上原生要求的 `consumer` 后恢复 ready。回归断言先在旧实现失败、修复后通过，三份已生成 Profile 仅补齐该字段，token 值和 Profile ID 保持不变。

随后通过运行中的 Host 并发启动三个真实 AGY 任务，再各继续一轮，六轮均成功。持久化记录显示三个不同 Profile、三个不同原生 conversation，第二轮各自保持原绑定与原会话；实际 commandExecution 输出的 HOME/GEMINI_HOME/SSH_CLIENT 与绑定一致，原口令也能从会话上下文恢复。

用户再次运行 `npm start` 后，同三个任务各执行第三轮，累计九轮全部成功。进程启动时间晚于前两轮验证时间，确认覆盖了 Host 冷恢复；原 Profile、conversation、上下文口令和真实命令环境均保持不变。测试任务只执行只读环境命令。过期 token 刷新、同账号多进程刷新竞争及配额扣减对账未实测；其他 OS 未实测。原生升级后仍需复核非公开存储接口。

首版的导入互斥由单个 Host/Adapter 实例负责，现有 mapping-store 的 Host 实例锁仍生效；手工在外部启动 AGY、并行使用另一个管理器，以及同一账号多个原生进程刷新时的行为不由此租约统一协调。
