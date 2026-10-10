# Codia × PI SDK 1.1.0 接入说明

- `pi-ai`、`pi-agent-core`、`pi-coding-agent` 固定为 `1.1.0`。
- 所有 PI 导入继续经 `lib/pi-sdk/index.ts`，私有契约集中在适配边界。
- 普通编程会话显式启用 `codemode` 与 `tool_search`；明确的无工具会话保持无工具，避免扩大权限。
- Codemode 子调用复用 Codia 已有工具定义，因此继续经过权限、沙箱、取消、检查点和文件备份链路。
- Tool Search 只在当前会话已有工具访问权时启用，不会恢复被禁用的插件或 MCP 工具。
- MCP 连接和凭据仍由 Codia 管理，SDK 不启动第二套 MCP 服务。
- 工具开始与结束事件透传调用 ID；并行同名调用按 ID 配对。SDK 提供的执行耗时进入执行过程卡。
- `scripts/patch-pi-sdk.cjs` 校验三包版本及关键导出，安装后不修改依赖目录。

验证命令：

```powershell
node scripts/patch-pi-sdk.cjs
npx vitest run tests/pi-sdk-session-options.test.ts tests/engine-extension-factories.test.ts
```
