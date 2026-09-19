# Skerry · 第一阶段迁移

正式产品名为 **Skerry**；`agents-gzt`、`AgentsGZT`、`com.agentsgzt.workbench` 和可执行文件名属于内部兼容标识，暂不修改。

## 启动

环境：Windows、Node.js 22，无需安装第三方依赖。

在本目录执行 `npm start`，然后访问 `http://127.0.0.1:4317`。
浏览器版使用 `launch-browser.ps1`。桌面版双击 `launch-desktop.vbs` 或执行 `launch.ps1`。服务仅监听本机。

## 本阶段范围

- 系统文件夹选择器选择本地项目，不修改所选项目文件。
- 左栏结构：本地项目 → 会话 → AI 分区，逐级展开。
- 同一会话内相同模型标识跨自定义供应商和官方登录合并；重复连接不重复添加。
- 不同版本不自动合并。供应商采用别名时，可显式填写统一模型标识。
- 设置只有自定义供应商、官方登录。
- 自定义供应商：API 地址、密钥、协议、获取模型列表、简短模型请求测试。
- 官方登录：独立迁移旧项目的 Claude、Codex、Kimi、Antigravity OAuth 适配器、回调和设备登录；系统浏览器授权，支持退出登录。
- Gemini OAuth 的 Google Client ID 与 Client Secret 通过环境变量 GEMINI_OAUTH_CLIENT_ID、GEMINI_OAUTH_CLIENT_SECRET 提供，源码不保存凭据。
- 密钥及登录令牌使用 Windows DPAPI 当前用户加密；普通配置存放于 `.data/workspace.json`，不包含密钥。

## 明确边界与待验收

会话主栏已接通各家真实 Agent 对话环（官方 Gemini = Antigravity/`agy` 工具名，Claude Code、Codex、Grok 各自独立 harness）。设置页的闪电测试仍是 `hi` ping，不会扩成聊天。工作台不 spawn 本机 `agy`/`claude`/`codex`/`grok`。自定义供应商只有协议对话，没有各家本地工具面。管理者可以把任务派到分区；分区内部的子 agent 仍用该产品自己的名字。

官方登录适配器来自旧项目，并未使用真实账号验证远程授权是否仍可用。回调端口被旧项目或其他应用占用时须先关闭相关登录流程。没有复制旧项目的用户数据或凭据。

自定义模型测试使用所选兼容协议的基础消息请求；某些特殊模型参数或非兼容接口可能需要后续适配。没有真实 API 密钥，因此未验证供应商实网调用。

Gemini、Grok 等未具备独立可迁移登录配置的入口暂不伪造；后续确认登录方案后添加。

桌面版采用 Tauri 2，保留独立窗口、单实例与服务自动启停；不依赖旧项目目录。Windows 安装包及程序自带 Node 运行环境，WebView2 由安装程序检查。开发构建需要 Node.js、Rust MSVC 和 Visual Studio C++ 构建工具。

## 检查

`npm test`：模型分组、版本隔离、重复添加、会话隔离、Windows 密钥加密、OAuth state 校验与公开响应不泄露令牌。

`npm run check`：服务及前端语法检查。

## 来源

从旧项目独立迁移 `secret-store.mjs`、`oauth/oauth-manager.mjs`、`desktop/host-bridge/cpa-oauth.mjs`，其余页面和本地服务重新实现。旧项目未修改。

## 桌面开发与安装

- `npm run desktop:dev`：开发模式桌面窗口。
- `npm run desktop:build`：构建 Windows 程序和 NSIS 安装包。
- 可执行程序：`src-tauri/target/release/agents-gzt.exe`，依赖同目录的 `runtime` 资源；不能仅复制 exe。
- 安装包：`src-tauri/target/release/bundle/nsis/`。
- 桌面配置：`%APPDATA%/com.agentsgzt.workbench/workspace.json`，加密凭据在同目录 `secrets` 中。
- 桌面版与浏览器开发版的数据目录独立；不会自动复制旧凭据，也不会关闭浏览器版服务。
- 本地服务使用系统分配的空闲端口；关闭桌面程序会清理它自己创建的服务。
- 开发项目固定使用已安装的 MSVC Rust 工具链，不修改全局默认工具链。
- 安装包尚未配置代码签名。Windows 可能显示未验证发布者提示。

## 2026-09-14 页面调整

- 暂停桌面启动故障排查；此前安装包不能视为已通过启动验收，本轮不重新发布桌面包。
- 工作台由双侧栏改为单侧栏：顶部 Logo、中部项目/会话/AI 分区、底部管理者 AI 和方块设置按钮。
- 管理者按钮向上展开选择面板。连接卡片参考截图布局，支持官方登录和已保存密钥的自定义供应商；模型可选择或手动输入。
- 管理者选择为全局配置，通过 `/api/manager` 保存；与会话分区互不修改，尚无调度执行行为。
- 设置为独立整页路由 `#settings/connections` 和 `#settings/manager`，不显示项目侧栏，提供返回与关闭入口，支持浏览器历史导航。
- 参考 CC Switch 的设置页组织，以及旧项目 ManagerSection 的连接/模型选择概念；未引入参考项目的代理、计费、公告、额度和其他功能。
- 11 项自动测试通过，包括管理者保存后服务重启恢复、无效连接拒绝及独立设置页面结构。浏览器工具本轮不可用，尚未完成本轮视觉验收。

