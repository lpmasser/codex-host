# Spec Delta

## Purpose

定义 WorkBuddy 国际版与国内版在 codexhost 中作为两个独立 Harness 的可观察行为：身份归属、安装发现与显式路径选择、启动配置与产品配置的发行隔离，以及按身份保存的选择。用户分别安装所需发行，两者互不借用程序、认证或数据。

## ADDED Requirements

### Requirement: Each WorkBuddy release is its own Harness

系统 SHALL 以 `workbuddy` 提供国际版、以 `workbuddy-cn` 提供国内版；两者各自拥有 Display Name、安装指引、版本检查和连接设置条目。既有 `workbuddy` 的 ID、已保存设置与既有 Thread SHALL 保持国际版含义，新 Thread SHALL 归属于创建它的身份。系统 MUST NOT 提供地区切换或跨身份的历史迁移。

#### Scenario: Both releases are enabled

- **WHEN** 目标 Host 同时启用两个插件
- **THEN** 连接页 SHALL 分别展示 WorkBuddy 与 WorkBuddy CN 及各自实际可用性
- **AND** 新建 Thread SHALL 使用所选 Harness 的 ID、显示名与安装指引

#### Scenario: An existing international Thread is reopened

- **WHEN** 升级后打开已有 `workbuddy` Thread
- **THEN** 它 SHALL 继续按国际版运行
- **AND** 国内版 Thread MUST NOT 因升级而改变身份或数据根

#### Scenario: Only the other release is installed

- **WHEN** 本机只安装了另一发行
- **THEN** 本 Harness SHALL 报告未安装，而不是把这台机器的另一发行当作已安装

### Requirement: Automatic discovery selects only the matching release

自动发现 SHALL 遍历两版共有的 macOS 与 Windows 安装布局，并 SHALL 只接受内置 CLI 的产品元数据声明本发行的安装。系统 MUST NOT 以安装目录名或可执行文件名判断发行，也 MUST NOT 回退到 PATH 中的独立 CodeBuddy。

#### Scenario: Both releases are installed

- **WHEN** 两个发行都安装在标准位置
- **THEN** 每个 Harness SHALL 各自选中属于本发行的应用与内置 CLI

#### Scenario: Only the other release is installed at a standard location

- **WHEN** 标准位置只有另一发行
- **THEN** 本 Harness SHALL 报告未安装，并且 MUST NOT 借用该安装的程序、认证或产品快照

#### Scenario: Candidate metadata is missing or contradictory

- **WHEN** 候选 CLI 的产品元数据缺失、不可读或同时声明两个发行
- **THEN** 自动发现 MUST NOT 选中该安装

#### Scenario: A standalone CodeBuddy is on PATH

- **WHEN** PATH 或标准位置存在独立 CodeBuddy
- **THEN** 任一 WorkBuddy Harness MUST NOT 把它当作自己的运行时

### Requirement: Explicit launch paths are verified for the requested release

通过启动设置或命令环境变量显式指定应用目录、Desktop 入口或独立 CLI 时，系统 SHALL 校验它声明的是本发行。指向另一发行时 SHALL 失败，并在错误中提示应选择对应 Harness；普通 CodeBuddy 或不声明任一发行的 CLI 同样拒绝。系统 MUST NOT 静默改用自动发现或其他安装。

#### Scenario: An explicit path of the other release

- **WHEN** 为 `workbuddy-cn` 指定国际版安装
- **THEN** 检查与启动 SHALL 失败
- **AND** 错误 SHALL 说明它是 WorkBuddy 并提示选择 `workbuddy`

#### Scenario: An explicit CLI declares no WorkBuddy release

- **WHEN** 指定的是一个不声明任一 WorkBuddy 发行的 CLI
- **THEN** SHALL 失败并说明缺少本发行产品元数据

#### Scenario: Launch overrides stay per release

- **WHEN** 只设置了国际版的命令覆盖
- **THEN** 国内版 MUST NOT 使用该覆盖，而 SHALL 使用自己的覆盖或自动发现

### Requirement: Configuration roots and product configuration stay within one release

每个 Harness SHALL 只读取自己的数据根覆盖，并默认以本发行根启动（`~/.workbuddy-ai` / `~/.workbuddy`）；子进程 SHALL 收到映射到单一产品的 `WORKBUDDY_CONFIG_DIR` 与 `CODEBUDDY_CONFIG_DIR`。继承的文件或内联产品配置、以及所选根下的 App 快照，若声明另一发行或普通 CodeBuddy 数据根，SHALL 在启动前失败且不回显其内容。不声明这些身份字段的局部配置 SHALL 保留；不可读或不可解析的显式配置 SHALL 拒绝，不可读的快照 SHALL 保留内置 CLI 的回退配置。

#### Scenario: Both root overrides are present

- **WHEN** 两个发行各自的数据根覆盖同时存在
- **THEN** 每个子进程只收到本发行的根
- **AND** 历史、子 Agent 与派生操作 SHALL 读取同一个根

#### Scenario: Plain CodeBuddy configuration is inherited

- **WHEN** 环境中的 `CODEBUDDY_CONFIG_DIR` 指向普通 CodeBuddy 数据
- **THEN** 任一 WorkBuddy Harness 的根 MUST NOT 因此改变

#### Scenario: Inherited product configuration declares the other release

- **WHEN** `ACC_PRODUCT_CONFIG_PATH`、任一内联产品配置声明另一发行
- **THEN** 启动 SHALL 失败
- **AND** 错误只给出配置来源与应选择的 Harness，MUST NOT 回显配置内容

#### Scenario: The root snapshot belongs to the other release

- **WHEN** 所选根下的 App 快照声明另一发行
- **THEN** SHALL 说明该根属于另一发行并失败

#### Scenario: Partial or unreadable configuration

- **WHEN** 产品配置不含发行身份字段
- **THEN** SHALL 原样保留
- **WHEN** 显式产品配置不可读或不可解析
- **THEN** SHALL 拒绝启动

### Requirement: Persisted selections follow the Harness identity

Native Ref、启动设置与 Model/Thinking/Permission 选择 SHALL 按 Harness ID 分开保存。跨身份的 Resume、Fork 与修订 SHALL 沿用既有身份校验被拒绝，MUST NOT 借用另一发行的会话。

#### Scenario: Derivation across identities

- **WHEN** 以国内版 Thread 的请求身份对国际版会话执行 Resume、Fork 或修订
- **THEN** SHALL 以身份不匹配拒绝

#### Scenario: Saved selections do not cross releases

- **WHEN** 为两个 Harness 分别保存启动路径或选择 Model、Thinking、权限
- **THEN** 每个 Harness SHALL 只读取自己保存的值
