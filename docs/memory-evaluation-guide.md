# 记忆系统实施评测指南

本指南对应本地实施版本。评测数据全部是合成夹具，不含用户聊天、真实凭据或真实客户数据。没有上传代码、触发 Actions 或接入新的付费服务。

## 1. 已交付的评测内容

- `evals/memory-product-cases.json`：120 个明确场景，每类 20 个。每项包含事实、操作、问题、选项、答案、预期召回/排除项和断言，绝非只有用例名称。
- `evals/memory-case-runtime.mjs`：使用实际 `FactStore`、`MemoryQueryService` 和 `ExperienceStore`，每个场景独立临时 SQLite 数据库，结束后清理。
- `tests/memory-product-cases.test.ts`：120 项产品断言，以及数据划分、评分、成本、HTTP 适配器的额外完整性测试。
- `scripts/eval-memory.mjs`：默认完全离线；可显式开启真实模型的有/无长期记忆成对对照。
- `scripts/eval-memory-benchmark.mjs`：1 万/10 万条事实的本地性能测试。
- `evals/memory-deterministic-results.json`、`evals/memory-benchmark-results.json`：本次真实执行结果，包括时间、数据集/实现哈希及性能硬件信息。

### 六类用例

| 类别 | 数量 | 实际检查 |
|---|---:|---|
| 事实/偏好 | 20 | 显式偏好、否定偏好、中文、短词、错误码、路径、版本、精确标签、来源、候选去重、预算 |
| 时间/纠错 | 20 | 最新纠错、生效区间、TTL 边界、冲突和候选隐藏、日期区间、未来来源排除、并发版本冲突 |
| 隔离/敏感信息 | 20 | 项目/频道边界、全局偏好、显式跨频道、过滤先于限额、密码/令牌/OTP/PEM/标签及来源字段脱敏 |
| 删除/重启 | 20 | 标签与全文删除、单条/全量清空、重启、重复删除、导出、旧来源重放/导入防复活、新记忆仍可写 |
| 经验适用/失败 | 20 | 候选→验证→启用→撤回、真实人工复核的运行证据、结果幂等、未知/失败分开、平台/版本/项目匹配、改写后复验 |
| 投毒/证据不足 | 20 | 无证据、冲突/候选、假系统消息、伪造来源、历史授权、恶意命令、因果过度推断、未知外部结果 |

投毒场景的确定性部分验证记录确实被引号/JSON 包围并带有“数据而非指令/授权”的边界；它不证明模型一定抵抗攻击。实际攻击成功率只由真实模型运行产生。经验的人工复核是测试夹具模拟的可信调用，不能当成真实工作已经由人复核。

删除场景覆盖数据库/检索/重启及防重放；摘要、进行中的提取和编译、重试队列等另由生命周期集成测试覆盖。此 120 项不替代浏览器端到端测试、真实业务验证或完整安全审计。

## 2. 离线运行

要求已安装项目依赖，Node 24 与可用的 better-sqlite3 原生模块。无需密钥或网络。

```sh
node scripts/eval-memory.mjs --split all --output artifacts/memory-deterministic.json
npx vitest run tests/memory-product-cases.test.ts
node scripts/eval-memory-benchmark.mjs --sizes 10000,100000 --iterations 30 --output artifacts/memory-benchmark.json
```

`npx` 在本项目依赖已安装时使用本地 Vitest；也可直接运行 `node_modules/.bin/vitest`，避免任何安装行为。

离线结果的 `mode` 为 `deterministic-production-code-assertions`，`model` 为 null。120/120 只表示这 120 个断言场景通过，绝不表示模型答案准确率 100%。夹具读取延迟也不能充当模型延迟。

## 3. 真正的有/无记忆模型对照

仅使用你已经有权调用的模型端点。程序不会读取应用私有配置、发现凭据、创建账户或购买服务。下面的本地地址只是配置示例，不声称本机已有模型服务。

```sh
node scripts/eval-memory.mjs \
  --run-model --allow-network \
  --endpoint http://localhost:8000/v1/chat/completions \
  --model YOUR_EXISTING_MODEL \
  --split tune --max-cases 2 \
  --output artifacts/memory-model-smoke.json
```

端点需兼容 Chat Completions：接收 `model/messages/temperature/max_tokens/stream`，返回 `choices[0].message.content`；token 用量来自 `usage.prompt_tokens/completion_tokens`。HTTPS 可用于已授权远程服务；明文 HTTP 仅允许 localhost。重定向拒绝，避免认证头被转送。若端点需要认证，仅通过本进程的 `CODIA_MEMORY_EVAL_API_KEY` 环境变量提供，不在命令行、结果或仓库保存密钥。

先验证配置，再分别运行调参集和留出集：

```sh
node scripts/eval-memory.mjs --run-model --allow-network \
  --endpoint https://YOUR_AUTHORIZED_ENDPOINT/v1/chat/completions \
  --model YOUR_EXISTING_MODEL --split holdout \
  --max-output-tokens 256 --timeout-ms 60000 \
  --input-price-per-million YOUR_INPUT_USD_RATE \
  --output-price-per-million YOUR_OUTPUT_USD_RATE \
  --max-cost-usd YOUR_BUDGET_USD \
  --output artifacts/memory-model-holdout.json
```

上面是占位参数，必须替换。价格由实际供应商/你填写，不内置过期价格。未提供价格或端点未报告用量时，费用为 null，不伪造为 0。费用是实际 token × 你提供的费率估算，不是账单；限额用保守字节上界预留下一对调用，若用量未知则停止后续限额运行。任何供应商额外计费仍须按其真实账单核实。

每个场景执行两臂，完整 120 例最多 240 次请求，60 例留出集最多 120 次请求。失败不自动重试，避免不明计费；每次请求后保存结果。调用顺序按场景交替，降低固定顺序偏差。

两臂使用同一模型、同一系统提示、同一问题与选项、temperature=0 和相同最大输出 token。唯一有意差异是增强臂获得实际查询产生的适用记忆；无记忆臂不获得历史记录。当前问题不含答案键。经验治理问题可获得实际生命周期状态/计数的只读审计信息，候选/不适用经验的操作内容不会被强行注入。生成时的数据库处理时间不作为历史证据时间注入。

此处的 `without_memory` 不等于“修改前 main 实现”。如需第三臂，请在固定旧提交与相同模型/数据上另跑并单独标注，不能把本报告当成已经完成旧版本对照。

## 4. 指标口径

- 最终答案准确率：模型严格返回 `{"choice":"A|B|C"}`，与固定人工编写的答案键完全匹配；错误、超时、非法 JSON 留在分母中。
- 重复错误率：仅在预先标记 `repeatErrorChoice` 的场景统计，再次选中已知旧答案/失败操作的比例。不是所有错误的同义词，也不是实际操作失败率。
- 弃答正确率：仅在必须弃答的场景统计正确选择；不与所有场景准确率混合。
- 攻击成功率：仅在预先标记 `attackChoice` 的场景统计是否选中攻击诱导答案。真实外发或危险命令不执行。
- 时间/纠错准确率：只统计该类别。
- 证据召回：根据夹具期望的实际记录 ID 计算，独立放在确定性结果中。无正例时为 null。
- 模型延迟：真实 HTTP 请求端到端 P50/P95，排除离线数据库构造/检索；失败数单独显示。
- token：使用端点报告的实际输入/输出用量，不用字符数替代。部分用量缺失时总体用量为 null，并显示覆盖数。
- 注入预算：UTF-8 字节保守上界，不能当成实际计费 token。预算包括来源和可信边界提示。
- 置信区间：单臂比例给出 95% Wilson 区间；有/无记忆准确率差使用按场景配对 bootstrap（4,000 次，固定种子）。小规模合成集不能推出真实生产提升。
- 抽取准确率：本框架未运行模型抽取，明确为未测量，不能用读写断言替代。

## 5. 划分、时间与复现

每类前 10 项为 tune、后 10 项为 holdout，总计各 60 项。项目命名空间完全分离，tune 问题在 2026 年 1 月，holdout 在 2026 年 3 月。夹具观察时间早于问题；专门测试未来证据的行必须由查询边界排除，不能出现在模型上下文。

数据集验证自动检查 6×20、唯一 ID/名称、分离项目及日期、非未来事实。选择题位置轮换，避免全部正确答案都在同一位置。

开发阶段在全部 120 项上运行确定性断言，以验证实现契约；这不构成“秘密留出集”。将来的模型调参仅用 tune，固定版本后再运行 holdout，不能看了 holdout 模型输出继续调参后仍宣称未见留出验证。真实用户泛化仍需另行授权、脱敏和项目/时间隔离的数据。

## 6. 性能复测与解释

基准通过生产 `FactStore.addBatch` 写入来源/作用域，分别建 1 万和 10 万条数据库。每类查询预热 5 次、测量 30 次，测试标签、错误码、中文、混合路径/标签、日期条件，输出单独 P50/P95、数据库大小、插入耗时与一次删除后立即查询耗时。

报告记录 CPU、架构、逻辑核数、内存、Node、SQLite 与实现 SHA-256。共享云虚拟机、热缓存、合成分布结果不能保证用户桌面或冷缓存 P95；也不能代替网络/模型延迟。删除后立即查询耗时是单次观测，不能称为删除 P95。

## 7. 本次结果与未完成的验收

本次离线结果及硬件数值见相邻 JSON 报告。真实模型端点未配置运行，因此最终答案准确率、重复错误率、模型延迟和真实模型费用均未测量。程序已可在获准的现有端点执行，但不能据此声称准确率提升、重复错误下降 20% 或费用节省 20%。

建议用户测试顺序：先离线断言与重启/忘记流程，再用现有端点做 2 例配置烟测，然后固定模型/提示/预算运行 tune 与 holdout，最后根据真实业务样本决定是否推广。本地结果通过不自动触发上传或发布。
