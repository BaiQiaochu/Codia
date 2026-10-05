# 参与 Codia 开发

## 环境与启动

- Node.js >=24.12.0 <25，建议 24.15.0。
- 使用 `npm ci` 安装锁定依赖，再执行 `npm start`。
- 源码启动自动管理 Vite 和 Electron，不需要先构建前端或 workspace 包。
- 使用 `GSAP_HOME` 指向独立数据目录；`GSAP_DEV_DESKTOP_PORT=0` 可自动分配前端端口。
- 原生依赖缺少预编译版本时需要 Python 和平台 C/C++ 工具链。

服务端运行于独立 Node 进程，SQLite 不需要 Electron ABI 重编译。源码依赖中的原生模块安装与应用安装包构建是两个独立过程。

## 提交前

按修改范围执行相关检查：

```bash
npm run typecheck
npm run typecheck:node
npm test -- <相关测试文件>
```

模型相关验证应使用本机模拟服务和隔离配置。不要将真实密钥、会话、用户文件、测试输出或编译产物提交到仓库。

`build:client`、`build:server` 和平台打包脚本仍可按需使用；它们不是源码开发的前置步骤。`build/installer.nsh` 是安装脚本源码，应保留在版本控制中。

## 报告问题

提供操作系统、Node 版本、复现步骤、预期和实际行为。提交日志前移除密钥、用户文件内容及其他个人信息。

## 许可证

贡献代码沿用 [Apache License 2.0](LICENSE)。保留既有版权、来源说明及第三方许可证。
