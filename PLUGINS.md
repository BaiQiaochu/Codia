# G-SAP 插件

插件用于把外部能力接入 G-SAP，同时保持权限、资源、配置和运行时边界清晰。任何插件功能都必须同时经过 UI、后端 route、工具注册、模型可见工具和 license capability 的一致管控。

## 目录结构

```text
my-plugin/
  manifest.json
  index.js
  tools/
  routes/
  assets/
  ui/
  providers/
  extensions/
```

最小 `manifest.json`：

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "main": "index.js",
  "trust": "restricted",
  "capabilities": {
    "tools": true,
    "pages": true,
    "assets": true
  }
}
```

## 能力边界

- `tools`：注册可被 Agent 调用的工具。工具返回文件时应登记为 SessionFile，避免前端、移动端和外部接入面拿到不一致的资源身份。
- `pages`：提供设置页、面板或 iframe UI。页面只负责显示和交互，不能替代后端权限检查。
- `assets`：通过受控静态资源 route 访问插件资源。路径穿越、dotfile、源码映射和非 Web 资源默认应被拒绝。
- `providers`：扩展文本、图像、视频或语音 provider。聊天能力和媒体能力必须分开声明，避免模型选择器误展示。
- `extensions`：接入请求流水线、上下文过滤或工具调用观察等高权限能力，只允许 full-access 插件使用。
- `config`：声明配置 schema。敏感值必须脱敏展示，后端保存和读取不能依赖前端隐藏。
- `tasks`：长任务必须走任务注册、状态更新、取消、完成和失败接口，不要私写 EventBus payload。

## 权限模型

插件分为两类：

- `restricted`：默认模式，可注册普通工具和静态配置，不能注入生命周期扩展、后端 route 或 provider。
- `full-access`：高权限模式，可使用 route、provider、扩展、后台任务和 iframe host capability。启用、安装或重载时需要明确授权。

安全原则：

1. UI 隐藏不是安全边界。
2. 插件 route 必须复用主程序 route authorization。
3. Agent 可见工具列表必须和 feature gate、license capability、插件启用状态同步。
4. full-access 插件变更后，空闲会话应刷新可见工具和扩展快照；忙碌会话保留旧快照直到自然重建。
5. 插件开发工具默认不可见，必须由用户在设置页显式开启。

## iframe UI

插件 UI 应放在 iframe 中运行，并通过 SDK host bridge 请求能力：

- `ready`：通知宿主页面已加载。
- `resize`：上报 iframe 高度。
- `toast`：请求宿主显示提示。
- `external.open`：打开外部链接。
- `clipboard.writeText`：写入剪贴板。
- `assets.url`：生成插件静态资源 URL。

不要把 token、API key、私有配置或源码文件放进 `assets/`。动态数据应走插件后端 route 或 SDK host request。

## Provider 插件

Provider 插件需要把能力声明拆清楚：

```js
export const id = "my-media-provider";
export const displayName = "My Media Provider";
export const authType = "api-key";
export const capabilities = {
  chat: { projection: "none" },
  media: {
    imageGeneration: {
      models: [{
        id: "my-image-model",
        displayName: "My Image Model",
        inputs: ["text"],
        outputs: ["image"]
      }]
    }
  }
};
```

本地 CLI provider 必须使用结构化参数绑定，不要拼接 shell 字符串。运行时应通过非 shell 执行，并让宿主校验输出文件范围。

## 开发循环

Agent 辅助开发插件时应使用开发槽位，而不是直接覆盖生产插件目录：

- `plugin.dev.install`：复制源码到开发槽位并加载。
- `plugin.dev.reload`：从同一源码位置刷新开发副本。
- `plugin.dev.enable` / `plugin.dev.disable`：只控制开发槽位启用状态。
- `plugin.dev.invokeTool`：执行工具冒烟测试。
- `plugin.dev.diagnostics`：查看加载状态、日志、页面和诊断。

这些工具必须由用户在设置中开启后才会暴露给 Agent。

## 验证

```bash
npm run build:packages
npm test -- tests/plugin-routes.test.ts tests/plugin-manager.test.ts tests/plugin-sdk-assets.test.ts
```

示例插件位于 `examples/plugins/sdk-showcase/`。

## Network And Iframe API

- Backend plugin code must declare `network.fetch` and call `ctx.network.fetch`. The host enforces allowed hosts, methods, localhost policy, timeouts, and response byte limits.
- Iframe UI should use `gsap.api.url` and `gsap.api.fetch` for its own plugin backend routes. The SDK adds the plugin surface session header automatically.
- Plugin assets may include web runtime files plus safe image, font, wasm, and video assets; keep secrets and source maps out of `assets/`.
