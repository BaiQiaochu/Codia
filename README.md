<p align="center">
  <img src="desktop/src/assets/codia/codia-brand-emblem.png" width="88" alt="Codia">
</p>

<h1 align="center">Codia · 小豆蔻</h1>

<p align="center">围绕本地工作空间的 AI 助手：聊天、文件、技能、多助手协作和工作流。</p>

## 从源码运行

需要 **Node.js >=24.12.0 <25** 和 npm。建议使用 Node 24.15.0。

```bash
git clone https://github.com/BaiQiaochu/Codia.git
cd codia-ggow
npm ci
npm start
```

`npm start` 自动启动本机 Vite 开发服务器、Electron 窗口及 Node TypeScript 服务端，**无需先执行 build 命令**。`npm run start:dev` 和 `npm run start:vite` 使用同一源码入口。

- 前端从 `desktop/src` 按需加载，支持 Vite 热更新；修改主进程、preload 或服务端后重启。
- 前端默认使用 `127.0.0.1:5173`，后端默认自动分配空闲端口。
- 默认数据目录沿用 `~/.codia-dev`，可通过 `CODIA_HOME` 指定。
- React/TypeScript 仍需开发服务器即时转换。Electron 沙盒 preload 在系统临时目录生成，退出后清理；启动不会生成 `desktop/dist-renderer` 或 `dist-server`。
- 仓库不包含安装包、依赖目录、模型密钥或个人会话。图片、字体及测试夹具属于源码所需资源。

Windows PowerShell 自定义数据目录和前端端口：

```powershell
$env:CODIA_HOME = "$env:USERPROFILE\.codia-source"
$env:CODIA_DEV_DESKTOP_PORT = "5174"
npm start
```

端口设置为 `0` 时自动选择空闲端口，适合隔离开发；日常使用建议固定前端端口以保持浏览器来源及本地界面偏好稳定。

`npm ci` 会安装 Electron 和原生依赖。如果当前平台没有可用的预编译依赖，安装过程可能需要 Python 和 C/C++ 工具链。SQLite 在独立 Node 服务进程运行，不需要对它执行 `electron-rebuild`。

## 主要能力

- **聊天与技能**：新对话、历史记录、工作空间上下文、技能徽章、`/` 命令，以及 `@` 文件、图片和助手引用。
- **Agent 小队**：频道协作、频道成员定时计划，以及助手审阅后由原助手续答。
- **工作流**：可保存的独立草稿、节点与连线、生成模板预览，以及执行时关联频道。
- **文件与媒体**：右侧工作空间、文件预览、附件、图片和语音能力。
- **聊天内图谱**：知识图谱和思维导图通过工具生成并作为聊天卡片展示。
- **扩展**：内置技能、插件、MCP、模型供应商和社交平台连接。

首次运行后在设置中配置模型。模型、搜索和连接器是否向外部服务发送内容，取决于所选供应商和功能；本地保存会话不代表所有请求均在本机完成。

## 常用开发命令

```bash
npm start                  # 完整桌面源码模式
npm run start:local         # 重新构建客户端，然后启动本地编译界面
npm run start:built         # 启动已有客户端构建（修改前端后先重新构建）
npm run build               # 构建客户端和独立服务端
npm run dev:web            # 浏览器开发模式（CODIA_DEV_HOME 指定数据目录）
npm run dev:renderer       # 单独启动 Vite，仅前端
npm run server             # 单独启动服务端源码
npm run cli                # 命令行入口
npm run typecheck          # 前端和测试类型检查，不生成文件
npm run typecheck:node     # 服务端类型检查
npm test                   # 单元与回归测试
```

构建及打包脚本保留供按需使用；默认启动和 CI 不再预先构建应用。GitHub 的安装包构建工作流只允许手动触发，推送源码或标签不会自动发布安装包。可选构建入口仍为 `build:client`、`build:server`、`dist:win`、`dist` 和 `dist:linux`。

### GitHub 云端安装包

在 Actions 中手动运行 **Build release artifacts (manual only)**，勾选 `publish_release` 后，云端将生成 Windows x64 安装程序、Linux x64 `.deb`、macOS Apple Silicon 和 Intel 的 `.dmg`／`.zip`。所有平台构建成功后才发布到同版本的 GitHub Release，并附 `SHA256SUMS.txt`。

云端使用源码中的版本号，不自动递增；已发布的版本不会覆盖，下一次发布前应更新 `package.json` 和锁文件中的版本。未勾选发布时，只保存 Actions 构建产物。云端流程不会删除本地依赖或构建目录。

当前 Windows 包无商业代码签名，macOS 为 ad-hoc 签名且未做 Apple 公证，首次安装可能出现系统安全提示。

### 本地编译与桌面验证

Git 只忽略本地依赖、编译输出和缓存，不会删除它们。已安装依赖的工作目录可以直接继续开发；只有首次克隆或锁文件发生变化时才需要重新运行 `npm ci`。

日常修改后执行 `npm run start:local` 即可重新编译客户端并打开桌面窗口。只重新编译可使用 `npm run build:client`；完整客户端和独立服务端使用 `npm run build`。构建脚本、锁文件、图标母版和 Live2D 运行素材均随源码保存。

`npm run check:local` 默认保留检查产物。仅在需要主动清理 `artifacts` 调试记录时添加 `-- --clean-after`；`-- --keep-artifacts` 明确保留这些记录。日常开发不要执行 `git clean -fdx`，它会删除 Git 忽略的本地依赖、缓存和编译输出。

源码模式需要保持启动终端运行；关闭终端或按 Ctrl+C 会结束开发服务器。`start:dev` 会额外打开开发者工具，日常查看完整界面使用 `npm start`。

`start:local` 每次重新生成客户端；本地编译界面默认仍由当前 Node 执行服务端源码。验证独立服务端构建时，先运行 `npm run build`，再在 PowerShell 中执行：

```powershell
$env:CODIA_DESKTOP_SERVER_MODE = "dist"
npm run start:built
Remove-Item Env:CODIA_DESKTOP_SERVER_MODE
```

桌面冒烟脚本自动创建临时配置、分配空闲端口并使用本机模拟模型，不需要配置付费模型。脚本结束后测试窗口自动关闭。

```powershell
npm run e2e:desktop-smoke
$env:CODIA_E2E_DESKTOP_MODE = "built"
npm run e2e:desktop-smoke
Remove-Item Env:CODIA_E2E_DESKTOP_MODE
```

第二组命令需要先完成 `npm run build`。窗口异常退出时，保留终端报错，并查看数据目录中的 `diagnostics/desktop-launch/renderer.log` 和 `crash.log`。

## 目录

```text
core/          核心编排与会话管理
lib/           工具、模型、记忆、沙盒和连接器
server/        HTTP 与 WebSocket 服务
hub/           频道、任务调度与助手协作
desktop/       Electron、preload 和 React 界面
shared/        跨进程协议与工具
packages/      插件 SDK、协议、组件和运行时源码
plugins/       内置插件
skills2set/    内置技能
scripts/       源码启动、检查及可选构建脚本
tests/         测试与夹具
```

## 文档与来源

- [贡献指南](CONTRIBUTING.md)
- [插件开发](PLUGINS.md) · [Plugin SDK](PLUGIN_SDK.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [许可证](LICENSE) · [来源与修改说明](NOTICE)

项目沿用 Apache-2.0 许可证。
