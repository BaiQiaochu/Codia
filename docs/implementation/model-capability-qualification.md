# 模型能力资格核心

对应需求：[`2026-10-16-requirements.md`](./2026-10-16-requirements.md) 的 P1-3「模型诊断与成本控制」及模板执行前模型检查。

## 实现入口

- `lib/model-qualification/`：固定能力样例、运行服务及持久报告。
- 复用 `engine.resolveModelWithCredentials` 及 `engine.modelRegistry.streamSimple`，不新建供应商请求引擎、不自动切换模型。
- 所有出站 payload 经过现有 `normalizeProviderPayload`，随后再次钳制输出预算。
- 复用 `lib/workflow/run-budget.ts` 和已有 `usageLedger`，记录每个请求的模型、手动触发来源及 request ID。

该服务不会在启动、首页或普通聊天中自动发起模型调用。任务中心及其 HTTP 入口移除后，运行时没有面向界面的自动触发路径；保留的服务只供受信任的内部调用方显式接入。

## 固定样例

| 能力 | 实际发送内容 | 通过条件 |
| --- | --- | --- |
| 文本 | 固定短指令 | 可见文本精确匹配标记且正常结束 |
| 工具 | 单个无副作用 JSON Schema 工具定义 | 真正返回一个同名工具调用，参数精确匹配、类型正确、没有额外键；不会执行该工具 |
| 视觉 | 内存生成的 64×32 双颜色 PNG | 正确辨别左右颜色；图片真实进入 SDK 传输 |
| 结构化输出 | OpenAI Chat Completions 的 `response_format.json_schema` 或 Responses 的 `text.format` | 实际请求钩子设置原生 schema，返回 JSON 严格校验通过 |

通过表示固定样例通过。它不证明供应商对所有 schema 均严格执行，也不代表某个工作流端到端验收通过。

工具及视觉元数据只用于拒绝已知不支持的路径，不能当作通过证据。未知 API、缺失请求钩子、截断、错误模型身份、无效结构均不能通过。目前预算适配器支持 OpenAI Completions、OpenAI Responses 和 Anthropic Messages；Anthropic 原生 schema 探测尚未实现，返回 `unsupported`，不把提示词要求的 JSON 冒充原生结构化输出。

## 内部调用契约

受信任的调用方仅检查文本和工具能力时使用等价参数：

```json
{
  "manual": true,
  "modelRef": { "provider": "configured-provider", "id": "configured-model" },
  "capabilities": ["text", "tool"],
  "budget": {
    "maxCalls": 2,
    "maxTokens": 300000,
    "maxUsd": 1,
    "maxDurationMs": 60000
  }
}
```

- `modelRef` 可省略，沿用当前运行模型。指定时必须包含 provider 和 id，使用已有模型解析器；不接受新端点或凭据。
- `capabilities` 可省略，默认检查四项。调用方传入的 `pass`、报告或资格标记都不会被信任。
- 最多 4 次串行请求、最多 120 秒、每次最多 256 输出 token，禁用 SDK 自动重试和缓存请求。
- 每次发起前预留完整配置上下文窗口加输出上限，再按供应商实际返回的 token 用量及本地配置单价结算。这较保守，预算可能需要高于固定提示词的实际消耗。
- 配置价格缺失/零占位、上下文/输出上限未知、预算不足时不派发。用量缺失、不一致、超出预留、取消或错误导致结果未知时，保留预留并阻止后续调用。
- 预算是按配置价格的本地调用准入，不是供应商账单硬上限。未覆盖的额外供应商收费不能当作零费用。

视觉默认不派发，返回 `media_pricing_unverified`。只在调用方明确记录用户确认这个固定小图按输入 token 估算费用时，才设置 `mediaTokenAccountingConfirmed: true`。该参数只覆盖本次固定探测图片，不授权任意图片、视频或音频；报告记录 `mediaAccounting: "fixture-input-token-estimate-confirmed"`。它不保证真实账单采用同样计价。

服务返回持久报告；`inspect({requiredCapabilities})` 可对已配置模型指定严格能力集合，读取本身不会调用供应商。

## 证据与失效

报告按 provider/model 分开持久化，文件仅保存模型身份、配置 SHA-256 指纹、样例版本、请求 ID、状态/原因、回复摘要哈希、时间与本地预算，不保存原始提示词/回复、供应商 URL 或认证凭据。

- 配置指纹涵盖当前解析模型、协议、端点、请求头、价格、能力及凭据。仅在内存中计算哈希；这些配置源值不写进报告。
- 24 小时过期；模型、配置、凭据或样例版本变化立即失效。
- 新探测先写 `running` 再调用，崩溃留下的报告不能沿用上次通过状态。
- 测试构造器注入 transport 的报告始终标记 `test-injected`，即使每项成功也不能给生产模板预检提供 pass。
- 外部错误使用固定原因码和建议，避免将供应商返回的私密地址或密钥写入 HTTP 响应/报告。

## 本地验证边界

`npx vitest run tests/model-qualification.test.ts` 覆盖四类样例、持久重读、过期/配置变更、预算/用量不明、未知价格、取消/超时/并发及脱敏。

额外通过真实 Pi SDK OpenAI-compatible adapter 加确定性注入 SSE HTTP transport，验证图像、工具定义和原生 schema 的真实序列化及流式回复解析。该测试没有外部网络调用，报告仍为 `test-injected`。

本轮未使用真实凭据或调用任何真实供应商。因此实际供应商质量、各模型/模板通过率仍待用户在已配置环境中手动测量。
