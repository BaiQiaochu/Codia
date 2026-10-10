# Provider 兼容层规范

> 本目录是 Codia 的 provider-specific payload 兼容层。任何按 provider 分支处理请求体的代码都必须遵守本文件规则。

## 核心纪律

1. **唯一对外入口**：所有出站 payload 兼容必须经过 [`core/provider-compat.ts`](../provider-compat.ts) 的 `normalizeProviderPayload(payload, model, options)`。chat 路径和 utility 路径共享同一个入口。
2. **通用补丁留在主入口**：与 provider 无关的处理写在主入口或同目录通用 helper，例如空 tools 数组剥离、thinking 字段清理、隐式 output cap 处理、toolResult 配对兜底。
3. **Provider-specific 补丁拆成子文件**：每个 provider 一个 `core/provider-compat/<name>.ts`，互不串扰。
4. **接口契约固定**：每个子文件导出 `matches(model): boolean` 和 `apply(payload, model, options): payload`。如果该 provider 还有 serializer 前的历史校验需求，可以额外导出 `normalizeContextMessages(messages, model, options): messages`。
5. **dispatch 保持单调**：dispatcher 按数组顺序遍历，第一个 `matches` 返回 true 的子模块负责处理。新 provider 默认放在数组末尾，只有更具体的规则才允许前置。
6. **禁止散落补丁**：`callText`、engine hook、route handler 等调用点禁止内联 provider-specific 补丁。一旦发现，迁移到本目录。

## 新增 Provider 补丁

1. 在 `core/provider-compat/` 下新增 `<provider>.ts`。
2. 文件顶部 JSDoc 必须写明：
   - 处理的 provider，例如 `provider` 字段值或 baseUrl 模式。
   - 解决的具体协议问题，最好链接到官方文档。
   - 删除条件，即 SDK 或 provider 官方支持后什么时候可以整块删除。
3. 导出 `matches(model)` 和 `apply(payload, model, options)`，签名保持稳定。
4. 在 `core/provider-compat.ts` 的模块列表末尾加入 import。
5. 为 `tests/provider-compat/<provider>.test.ts` 或相邻测试补覆盖：
   - `matches` 真值表，包括正例、反例、`model = null`。
   - `apply` 在 `mode: "chat"` 与 `mode: "utility"` 下的行为。
   - 不可变性断言，确保不直接 mutate 输入 payload。

## 升级 SDK 时的检查清单

升级 `@mariozechner/pi-coding-agent` 或 `@mariozechner/pi-ai` 后必须检查：

1. 运行 provider compat 相关测试和完整回归测试。
2. 对照 SDK changelog 检查每个子模块顶部的删除条件。
3. 如果官方已经原生支持某个兼容补丁，删除对应子模块并从模块列表移除。
4. 如果 SDK 改了 `convertMessages` 后的 assistant payload 形态，更新 replay/history 解析逻辑和相关测试。

## 接口契约

### `matches(model): boolean`

实现要求：

- 纯函数，无副作用。
- 优先使用 `provider`、`baseUrl`、`quirks`、`compat.thinkingFormat` 等结构化字段，避免只按 `model.id` 字符串硬匹配。
- 必须容忍字段缺失。遇到 `model = null/undefined` 或目标字段不存在时返回 `false`，不得抛错。
- 不依赖 `this`。dispatcher 通过 namespace object 调用，`matches` 必须是顶层导出的独立函数。

### `apply(payload, model, options): payload`

实现要求：

- 保持不可变契约。返回新对象，或在未修改时返回原对象；不得直接 mutate 调用方传入的 payload。
- 同时覆盖 `mode: "chat"` 与 `mode: "utility"` 两种上下文。
- 容忍 `model` 字段缺失，宁可不补也不要错补。
- `options` 是开放扩展字段，子模块只读取自己关心的字段，未识别字段必须忽略。

## Thinking 格式声明

`reasoning` 只表示模型具备思考能力，不表示请求体应该使用哪种字段。请求侧思考控制统一由 `model.compat.thinkingFormat` 表示。

| 值 | 请求体格式 | 例子 |
|---|---|---|
| `anthropic` | `thinking: { type, budget_tokens }` | Anthropic、Kimi Coding、MiniMax Anthropic API |
| `qwen` | `enable_thinking: boolean` | DashScope、SiliconFlow、ModelScope 上的 Qwen-style 模型 |
| `qwen-chat-template` | `chat_template_kwargs: { enable_thinking, preserve_thinking }` | MiMo OpenAI-compatible API |
| `zhipu` | `thinking: { type, clear_thinking }` | Zhipu / BigModel GLM OpenAI-compatible API |
| `deepseek` | DeepSeek 子模块统一转换 | DeepSeek V4 / reasoner |
| `openrouter` | `reasoning: { effort }` | OpenRouter-hosted reasoning models |

`compat.reasoningProfile` 表示同一 wire format 内部更细的协议契约。例如 `deepseek-v4-anthropic` 表示 Anthropic Messages 请求体，但思考强度写入 `output_config.effort`，并且工具调用历史需要在 serializer 前校验 thinking replay。

## 输出预算策略

`maxOutput` / `model.maxTokens` 在 Codia 数据层表示模型能力上限，不表示每次请求的默认输出长度。对于 OpenAI-compatible、Gemini、Mistral 等 output cap 可省略的 provider，兼容层会避免把 SDK 注入的隐式默认值误当成用户配置。

1. chat 请求中，如果 payload 的 output cap 等于 SDK 从 `model.maxTokens` 推导出的隐式默认值，则移除该字段，让供应商默认策略生效。
2. utility 请求由具体任务决定预算。标题、健康检查、记忆摘要等任务需要限制长度时必须显式传入 `maxTokens`。
3. Anthropic / Bedrock / `anthropic-messages` 这类协议必填 output cap 的 provider 不移除调用方显式传入的 cap。
4. 真正的用户级或系统级单次输出上限必须通过 `options.outputBudgetSource = "user" | "system"` 或等价字段显式声明。

## 音频输入 Transport

Codia 内部用 `{ type: "audio", data, mimeType }` 表示当前轮音频。UI、SessionFile、历史恢复、附件、压缩与缓存逻辑只处理这一种内部语义，不按 provider 写分支。

出站请求分两步：

1. utility 路径由 `core/provider-media-serializer.ts` 把当前轮 audio block 序列化为 Chat Completions 官方结构。
2. chat 路径经过 Pi SDK 后，再由 `normalizeProviderPayload()` 在 provider 子模块之前执行 audio transport pre-pass。

未来接入新的音频 provider 时，优先在 known model / provider sync 投影里声明 `compat.audioTransport`，不要在 UI、SessionFile、`desktop-session-submit` 或 `session-coordinator` 里写 provider 分支。

## 已知子模块

| 文件 | 处理 provider | 删除条件 |
|---|---|---|
| [`deepseek.ts`](deepseek.ts) | DeepSeek 思考模式协议、reasoning_content 恢复与校验 | DeepSeek 或 SDK 原生处理 reasoning_content |
| [`mimo.ts`](mimo.ts) | MiMo OpenAI-compatible 思考模式协议、chat_template_kwargs 与 reasoning_content 回放 | MiMo 或 SDK 原生处理 MiMo replay |
| [`qwen.ts`](qwen.ts) | Qwen-style thinking、DashScope 视频输入兼容 | Qwen-style 协议或 SDK 原生覆盖现有补丁 |
| [`zhipu.ts`](zhipu.ts) | Zhipu / GLM thinking、reserved thinking、reasoning_content 回放 | SDK 原生处理 GLM thinking 与回放 |
| [`input-audio.ts`](input-audio.ts) | 通用 OpenAI-compatible 音频 transport helper | SDK / provider serializer 原生输出正确音频结构 |
| [`openai-video-url.ts`](openai-video-url.ts) | OpenAI-compatible 视频输入从 `image_url data:video` 转为 `video_url` | SDK 原生按 video MIME 输出 `video_url` |

子模块对外 API 只有 `matches` 和 `apply`。其他 export 属于实现细节，仅供同文件和单元测试访问，不构成对外契约。
