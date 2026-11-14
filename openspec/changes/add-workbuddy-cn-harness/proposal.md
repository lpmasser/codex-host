# Proposal

## Why

WorkBuddy 国际版（workbuddy.ai）与国内版（workbuddy.cn）是不同产品：各自拥有产品元数据、认证端点、服务和原生数据根。同一份内置 CLI 换上另一发行的数据根与产品快照时，ACP `session/new` 返回 `Authentication required`，因此不能用一个 Harness 按目录自适应切换。当前只有 `workbuddy` 一个身份，国内版用户没有可用的原生接入。

## What Changes

- 新增 `workbuddy-cn` 预装插件：独立 Harness ID、Display Name、安装指引、连接设置条目和版本检查；`workbuddy` 的 ID、启动设置与既有 Thread 含义保持为国际版。
- 自动发现与显式启动路径都按 CLI 包内 `product.json` 识别发行；两版同装时各选各的，只装一版时另一 Harness 如实报告未安装。
- 启动覆盖、数据根覆盖、产品快照和继承的产品配置按发行隔离；另一个发行或普通 CodeBuddy 的产品配置在启动前被拒绝。
- Native Ref、启动设置与 Model/Thinking/Permission 选择按 Harness ID 分开保存；不提供地区切换或历史迁移。

## Decisions

- 用 `product.json` 声明的产品身份（数据目录名、服务端点 origin、认证身份）判断发行，而不是安装目录名或可执行文件名：两版的 Windows 布局名称并不可靠区分，目录名也会随安装方式变化。
- 国内版使用独立覆盖 `CODEXHOST_WORKBUDDYCN_COMMAND` 与 `WORKBUDDYCN_CONFIG_DIR`。Host 同时驱动两个身份，但原生 CLI 每次只运行一个产品，因此只在启动子进程时映射为 `WORKBUDDY_CONFIG_DIR` 与 `CODEBUDDY_CONFIG_DIR`；不建立第二套凭据或配置存储。
- 声明另一发行或普通 CodeBuddy 数据根的产品配置视为错误而不是回退：报错指出对应 Harness，不静默换版、不借用其认证或快照。未声明这些身份字段的局部配置照常保留，避免把未知自定义服务推断为任一发行。
- 复用 `packages/adapters/workbuddy` 的公共 Adapter 实现，国内版包只提供 Manifest 与工厂入口；不复制会话、历史或派生实现，也不让 Host 直接 import 具体 Adapter。

## Capabilities

### New Capabilities

- `workbuddy-release-isolation`：两个 WorkBuddy 发行作为独立 Harness 的身份、发现、显式路径校验、配置隔离与按身份持久化行为。

### Modified Capabilities

无。沿用现有 Harness 会话、历史、派生、路由与启动设置契约；不改变官方 Codex Thread 路径。

## Impact

主要实现位于 `packages/adapters/workbuddy`（共用 Adapter 与发行表）和新增的 `packages/adapters/workbuddy-cn`（Manifest 与工厂入口）；同时调整预装清单、构建与 TS 引用、插件加载、Renderer 连接页与路由，以及 WorkBuddy 功能文档和 `docs/index.md`。无公共协议、落盘格式或官方 Codex 流量变化。
