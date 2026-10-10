# Codia 模型能力清单（2026-10-09）

核对日期：2026-10-09。此清单区分“官方文档已核实的静态能力”和“通过供应商 API 动态扫描的目录”。动态扫描只更新候选目录，用户确认后才写入配置；扫描失败时继续使用已有配置。

## 已核实的新模型

| 供应商 | 模型 ID | 输入 | 上下文 / 输出 | 思考档位 | Codia 传输 |
|---|---|---|---|---|---|
| OpenAI | `gpt-6-astra` | 文本、图片 | 1,048,576 / 128,000 | low、medium、high、xhigh、max；不可关闭 | Responses |
| OpenAI | `gpt-6.1-sol` | 文本、图片 | 1,048,576 / 128,000 | low、medium、high、xhigh、max；不可关闭 | Responses |
| OpenAI | `gpt-6-luna` | 文本、图片 | 1,048,576 / 128,000 | off、low、medium、high、xhigh、max | Responses |
| Anthropic | `claude-fable-5-1` | 文本、图片 | 1,000,000 / 128,000 | 自适应；不可关闭 | Anthropic Messages |
| Anthropic | `claude-opus-5-5` | 文本、图片 | 1,000,000 / 128,000 | 自适应；不可关闭 | Anthropic Messages |
| Anthropic | `claude-sonnet-5-5` | 文本、图片 | 1,000,000 / 128,000 | off、low、medium、high、max | Anthropic Messages |
| Anthropic | `claude-haiku-5-5` | 文本、图片 | 1,000,000 / 128,000 | off、low、medium、high、max | Anthropic Messages |
| Google | `gemini-3.8-flash` | 文本、图片、视频 | 1,048,576 / 65,536 | low、medium、high；不可关闭 | Google Generative AI |
| DeepSeek | `deepseek-flash` | 文本、图片 | 1,000,000 / 384,000 | off、low、high、max | OpenAI compatible + DeepSeek adapter |

来源：

- OpenAI 模型与最新模型迁移：[Models](https://developers.openai.com/api/docs/models)、[Latest model](https://developers.openai.com/api/docs/guides/latest-model)
- Anthropic 模型与思考机制：[Models overview](https://platform.claude.com/docs/en/models/overview)、[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- Google Gemini：[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[Thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- DeepSeek：[Updates](https://api-docs.deepseek.com/updates/)、[Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)

## 37 个内置入口

| 分组 | 内置入口 | 目录策略 |
|---|---|---|
| 原厂 | OpenAI、Anthropic、DeepSeek、Google Gemini、xAI、Mistral、MiniMax、Ollama、SGLang | 官方静态基线 + 动态扫描；能核实的型号写入能力表 |
| 聚合与托管 | OpenRouter、SiliconFlow、Groq、Together、Fireworks、ModelScope、Infini、Perplexity、Agnes | 以端点动态扫描为准；不把上游模型能力猜测成网关保证 |
| 中国厂商 | DashScope、Zhipu、Moonshot、Baichuan、StepFun、Volcengine、Hunyuan、Baidu Cloud、MiMo | 保留现有基线；扫描结果经过类型筛选后由用户确认 |
| Coding Plan | DashScope Coding、Kimi Coding、Volcengine Coding、Zhipu Coding、OpenCode Go、MiniMax Token Plan、MiMo Token Plan | 独立入口和认证；保留套餐专属协议与请求头 |
| OAuth / 系统能力 | OpenAI Codex OAuth、System Speech、Volcengine Speech | 使用各自专用认证或媒体协议，不混入普通聊天模型列表 |

## 统一档位

| 界面档位 | 实际请求 |
|---|---|
| 关闭 | 仅模型支持 `off` 时显示 |
| 中等 | 优先 `medium`；缺失时选 `low` |
| 深度 | `high` |
| 极限 | 优先 `max`，其次 `xhigh`；都不支持时不显示 |

模型条目可携带 `thinkingLevels` 和 PI SDK 的 `thinkingLevelMap`。运行时、设置页和会话恢复读取同一份能力元数据。无法从官方来源确认的型号由扫描结果保留原始 ID，并标记为动态发现，不推断上下文、计费或思考能力。
