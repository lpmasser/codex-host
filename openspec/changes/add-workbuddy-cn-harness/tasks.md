# Tasks

实施顺序：发行身份与打包 → 发现与显式路径 → 配置隔离 → 文档与实机验收。行为验收见 [spec](specs/workbuddy-release-isolation/spec.md)。

## 1. 发行身份与插件

- [x] 1.1 建立发行表（Harness ID、显示名、启动覆盖、数据根覆盖、默认根、产品身份字段），`workbuddy` 固定为国际版；新增 `workbuddy-cn` 的 Manifest、图标、安装指引、工厂入口与预装清单，复用公共 Adapter 而不复制会话实现。验证：插件加载与预装清单测试、连接页显示名/网址测试、两版工厂分别返回各自 Harness ID 的检查测试。
- [x] 1.2 让共用 Adapter 按发行绑定运行档案、启动调用、安装检查和 Windows 产品模型补充。验证：两版各建 Session 时 Native Ref 使用各自 `harnessId`，历史/Fork/修订能力声明与共用实现一致。

## 2. 发现与显式路径

- [x] 2.1 自动发现按候选 CLI 包内 `product.json` 识别发行，只接受本发行。验证：受控 fixture 覆盖 macOS/Windows 仅装一版、两版同装、目录名与发行不一致、元数据缺失或矛盾、PATH 中的独立 CodeBuddy。
- [x] 2.2 显式应用目录、Desktop 入口与独立 CLI 校验本发行，另一发行或无身份元数据时给出指明来源与目标 Harness 的错误；启动覆盖按 Harness 分开读取。验证：受控 fixture 覆盖显式另一发行、普通 CodeBuddy、仅设置一版覆盖时另一版的解析结果。

## 3. 配置隔离

- [x] 3.1 数据根按发行解析，子进程映射为原生单产品变量，历史/子 Agent/派生读取同一根。验证：fixture 断言两个子进程环境、仅一版根覆盖时的默认根、普通 `CODEBUDDY_CONFIG_DIR` 不改变任一发行、国内版历史从国内根读取。
- [x] 3.2 产品快照与继承产品配置按发行校验：另一发行或普通 CodeBuddy 数据根失败且不回显内容，无身份字段的局部配置保留，不可读的显式配置拒绝、不可读快照保留内置回退。验证：fixture 覆盖显式文件与内联配置、根下快照、未知自定义服务、不可解析配置的错误信息。
- [x] 3.3 跨身份 Resume、Fork、修订按既有身份校验拒绝；启动设置与 Model/Thinking/权限选择按 Harness ID 保存。验证：两版各用异身份 Native Ref 调用三个派生入口均返回身份不匹配；Renderer 选择状态与启动设置按 ID 隔离的测试。

## 4. 文档与验收

- [x] 4.1 更新 WorkBuddy 功能文档、发现与插件运行架构文档、`docs/index.md`，说明两版身份、发现规则、配置隔离与未验证边界。验证：`docs/index.md` 的链接指向存在的文档（人工核对）；`npm run format:check`、`npm run lint`、`npm run typecheck` 对本次代码改动退出 0。
- [ ] 4.2 国内版真机验收：macOS WorkBuddy 5.6.2 / 内置 CLI 2.147.0 的真实对话、历史、Fork/修订、认证与 Native Ref，以及 Windows 安装布局与连接页。验证：记录 App/CLI 版本、平台和实际结果；受控 fixture 结论不得替代。当前仅静态确认国内版 CLI 包含公开 `--fork-session` 模式与 rollback 扩展，未在线执行。
