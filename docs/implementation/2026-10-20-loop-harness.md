# Loop、Harness 与 Agent 小队实施记录

日期：2026-10-20。基线 HEAD：`dc05d6c`，工作区原有修改保留。本文记录本轮增量修改，不代表工作区全部差异均由本轮产生。未提交、推送、发布或制作安装包；未调用收费模型或发送真实社交消息。

## 1. 分阶段交付

| 阶段 | 修改 | 主要文件 |
| --- | --- | --- |
| 基线 | 修正报告模块移动后的导入；保留 30 项文本/决策评测的协议；修正记忆 CLI 在 Vite 测试转换时的 shebang 收集错误 | `shared/model-task-report.mjs`、`scripts/model-task-evaluation.mjs`、`scripts/eval-memory.mjs` |
| 运行控制 | 统一任务额度、暂停、继续、取消、绝对排队截止时间；SDK 请求和动态工具执行前登记 | `lib/execution/`、`lib/pi-sdk/execution-run.ts`、`core/session-coordinator.ts` |
| 其他执行入口 | 桥接、Hub 多轮、小队及隔离子助手使用相同控制；定时任务的来源会话不作为父任务；自动化显示暂停 | `core/bridge-session-manager.ts`、`hub/agent-executor.ts`、`hub/scheduler.ts`、`lib/desk/cron-scheduler.ts` |
| 恢复 | 版本化运行记录、未知写入确认、旧进程隔离、会话移动时一起移动额度记录；Workflow 累计账本 | `lib/execution/run-controller.ts`、`lib/workflow/`、`lib/tools/workflow-tool.ts`、`server/routes/sessions.ts` |
| 过程显示 | 稳定 runId 与事件版本；同一任务继续后归入原过程区域；父调用 ID、进度、耗时和暂停操作 | `server/routes/chat.ts`、`core/message-utils.ts`、聊天过程组件及流缓冲 |
| 本地可靠性 | 编辑版本校验、同路径写入互斥、临时写入替换、检查点失败可见、固定搜索工具版本、完整输出资源引用 | `lib/resource-io/`、`lib/checkpoint-wrapper.ts`、`lib/pi-sdk/search-tools.ts`、`lib/tools/full-output.ts` |
| 评测 | 独立真实工具运行 Harness；纠正召回统计，增加 tune/holdout 困难样例 | `evals/agent-runtime-*`、`scripts/eval-agent-runtime.ts`、`evals/memory-*` |
| Agent 小队 | 导航、空态、开关、警告、成员操作、工作流及相关错误用语统一；五种语言同步；失败回滚和提交防重 | 小队组件、`channel-actions.ts`、`core/config-coordinator.ts`、五份 locale |

已删除的“任务与成果”页面没有恢复。内部 `channels` API、配置键、文件格式及历史 ID 没有改名；社交平台自身的频道概念保留。

## 2. 额度和状态语义

每段额度为 **128 次模型请求、512 次工具调用、60 分钟活动时间**。普通聊天不使用严格费用预算器拒绝未知价格模型或媒体。

- 同一任务的主助手、隔离子助手、Hub 多轮和 Codemode 子调用共享控制对象。SDK 重试及压缩经实际模型传输边界计数。
- 并发操作先同步登记后执行，避免“各自检查通过”造成超发。时间按活动区间经过的时间计算；等待批准且没有其他工作时停止计时。
- 原有 20 分钟无活动超时保留。提交队列从入队起计算 15 分钟，重复 `session_busy` 不重置截止时间。取消和过期会显式返回。
- 到限进入 `pausing → paused`；旧 SDK worker、模型请求和工具未退出前不能继续。取消、完成、失败、暂停和需要核对分别表示。
- 后台结果可以登记，但暂停期间不触发模型。小队原会话暂停时，不因会话活跃窗口到期而轮换成新会话。
- 用户继续时追加同等额度，保留 runId、用量及追加次数。请求携带 revision，重复/过期继续返回冲突。
- 工具历史保留阻断结果，继续提示要求检查已完成结果，不自动重放旧写入。动作账本继续约束已完成和结果未知的写操作。
- 短 `write/edit` 不因额度取消信号强制截断；命令等使用取消链路。外部操作已发出不等于已撤回。
- 外部 Wukong 运行器无法报告内部模型/工具调用，因此受共享额度约束的委派会拒绝；只有已配置本地 fallback 时才进入本地受控链路。独立外部运行器未声称具备内部额度控制。

## 3. 持久化、接口和迁移

### 会话运行记录

新增伴随文件：

- `<session>.run.json`：schemaVersion 1，当前任务状态、revision、额度、用量、ownerPid、待结算工具和后台任务。
- `<session>.run.json.history`：后续独立任务开始前保存上一任务的摘要。
- 会话 JSONL 内的 `codia-execution-run` 自定义条目记录 runId，重载历史可重新聚合。

执行前写入记录并同步落盘；持久化失败阻止继续执行。归档、恢复和活动会话提升会一起移动额度文件，目标存在或活跃操作未退出时拒绝移动。

旧会话没有新文件时正常读取，新任务开始才建立记录。重启不自动发模型请求或重放写入。中断时保留已测量耗时，标记 `activeTimeUncertain`；明确继续时丢弃旧段未核实的时间余量，追加一段完整额度，不伪造耗时。

新增接口沿用会话路径和访问范围校验：

| 接口 | 作用 |
| --- | --- |
| `GET /api/sessions/execution-run?path=...` | 读取状态 |
| `POST /api/sessions/execution-run/resume` | `path/runId/revision`，明确继续 |
| `POST /api/sessions/execution-run/stop` | `path`，停止 |
| `POST /api/sessions/execution-run/acknowledge` | `path/runId/revision/reviewed/toolIds`，用户核对未知写入后解除阻断 |

确认未知结果不等于执行或回滚工具。前端显示待核对调用，勾选确认后才能继续。`resume_stream` 仍然只回放消息。

### Workflow

新增 metadata version 2 和 budget state version 1，记录累计步骤、调用、token、费用账本、耗时及未结算预留。恢复校验原定义、模型与限额，不创建一份新预算。

旧账本证据不足、预算耗尽、预留未结算、未知写入、损坏记录及仍活跃的旧进程继续阻断。原有动作防重、版本校验和恢复互斥保留。新增格式无需破坏性迁移；回退旧源码之前，应先停止新任务并保留运行记录，旧版本不具备本轮的恢复保证。

## 4. 本地操作的有意行为变化

- 编辑以读取内容的 SHA-256 版本作为提交条件；同大小、同时间戳的外部改动也能识别。冲突要求重新读取，不能静默覆盖。
- 普通文件使用同目录临时文件、落盘、替换。替换失败保留原文件；多硬链接/非普通文件明确拒绝。符号链接解析到实际目标。
- 启用检查点时，备份失败阻止该操作并提供错误。任意 Shell 命令不再被描述为完全可撤销；只对已识别的变更提供覆盖说明。
- 搜索工具使用受管固定版本：ripgrep 15.2.0、fd 10.5.0，版本文件包含官方来源和资产 SHA-256。系统可用工具继续优先使用；下载可取消，失败清理临时文件。
- 大结果提供最多 2 MiB 的结果文件/资源引用，并标注原始大小及二次截断。此文件不是无限量完整日志。
- Windows 沙箱不支持的禁网组合继续拒绝，不提示默认关闭沙箱绕过限制。

## 5. Harness 与召回结果

### 工具执行 Harness

`eval:agent-runtime` 使用生产 PI SDK、工具组装、权限、检查点、动作账本、取消和延期结果扩展；模型响应由本地确定性服务提供。每例独立临时目录及配置，不读取生产账号/插件凭据。

最新独立运行：**11 通过、0 失败、1 环境阻塞**，报告 `artifacts/loop-agent-runtime-final.json`。

通过场景包含多文件修改与检查失败后修复、同名并行与 Codemode 父子调用、测试插件、真实本地 MCP stdio、权限拒绝/撤销、额度暂停/重复继续/后台结果、命令取消、中断未知写入、冷恢复不重复写入、SDK 压缩、错误成果负对照，以及生产浏览器工具/管理器驱动的隔离 Electron/Chromium 本地页面。

**环境阻塞：Windows 原生沙箱 helper 未安装。** 权限测试不能代替 OS 隔离测试。`--require-all` 会因此返回失败，避免把缺组件算成通过。浏览器用例使用独立测试宿主，不代表全部桌面 UIA/CUA 已验收。

原文本/决策 Harness：**30/30，通过 111/111 分**。两种模拟评测只验证运行机制，均不能宣称真实模型任务成功率。

真实模型入口需同时传 `--live-config FILE --allow-model-calls`；配置显式指定 `baseUrl/api/model/apiKeyEnv`，不自动读取应用凭据。本轮没有执行。

### 召回

| 数据集 | 用例 | 候选召回 | 最终注入召回 | Precision@K | 失败率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原合成回归 | 120 通过，70 有召回标注 | 100% | 100% | 宏平均 13.04% | 0% |
| 新困难 tune | 7 | 100% | 100% | P@1 = 100% | 0% |
| 新困难 holdout | 7 | 100% | 100% | P@1 = 100% | 0% |

Precision@K 按“前 K 个注入项中的相关项 / 配置 K”计算，未填满的位置为零；原集合 K 不同且标注相关项较少，不能与 P@1 直接比较。失败的有标注样例纳入分母，基础设施故障单列。旧实现按返回条数计算的结果不可直接作为新指标基线。

优化限于 NFKC/空白规范化、少量实体别名和精确命中排序，未引入数据库或自动下载向量模型。困难样例覆盖中文简称、同义改写、时间变化、相似主体、过期事实及长历史；另有跨助手隔离测试。holdout 仅评测，不用于调参。

这些都是固定合成样例；**真实用户召回率、提取准确率、最终回答质量尚未测量**。

## 6. 验证记录

局部回归集合存在重叠，不累加成独立通过数。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 全量 Vitest | **6,741 通过、0 失败、206 跳过**；1,193 文件通过、13 文件整组跳过，共 1,206 文件 | `artifacts/loop-full-final.json`、`artifacts/loop-full-final.log` |
| 前端及测试代码类型检查 | 通过 | `artifacts/loop-typecheck-final.log` |
| Node 侧类型检查 | 通过 | 同上 |
| 客户端构建 | 通过 | `artifacts/loop-build-client.log` |
| 服务端构建 | 通过；317 个运行模块导入检查、SQLite 运行冒烟及 PI SDK 版本校验通过 | `artifacts/loop-build-server.log` |
| 工具 Harness | 11 通过、0 失败、1 环境阻塞 | `artifacts/loop-agent-runtime-final.json` |
| 文本/决策 Harness | 30/30，通过 111/111 分 | `artifacts/loop-model-task-final.json` |
| 召回评测 | 原集合 120、新困难集合 14 均通过 | `artifacts/loop-memory-{baseline,tune,holdout}.json` |
| 差异空白检查 | 通过 | `git diff --check` |

构建使用本机已有环境及公开依赖缓存，没有使用收费运行器。服务端保留原有 `hermes-agent-runtime skipped (source-missing)` 提示，该可选运行器没有恢复。构建产物含新的运行控制逻辑；未据此声称完成原生桌面全部交互验收。

已有跳过项不是本轮新增。大部分来自源码中明确标记的“上游测试契约待迁移”；其他为 Windows/macOS 平台条件或手动打包环境条件。旧检查中的“353 通过、1 跳过”属于局部集合，不能代替全项目统计。保留这些跳过项的名称和数量在全量 JSON 报告中。

跳过项分布：Agent executor 14、Agent defaults 8、platform prompt 3、workspace switch 3、artifact snapshots 14、bridge RC 8、bridge routes 2、bridge teardown 38、bridge status 1、bridge narration 78、browser extractors 8、browser schema 3、macOS CUA 2、debrand boundary 1、server ownership 1、startup contracts 13、Windows 大小写文件名条件 1、TS migration inventory 2、手动 Windows 安装包冒烟 6。新增的真实 Hub 多轮额度测试不依赖已跳过的旧 executor 测试。

最终全量执行退出码 0，耗时约 339 秒。修复过程中出现的旧文案断言、缺翻译及脚本收集错误均已修正并纳入这次完整复跑；没有增加 skip 或禁用检查来获得通过。

## 7. 手动复核命令

在仓库根目录，Node 24 环境执行：

```powershell
npm run typecheck
npm run typecheck:node
npx vitest run --maxWorkers=2 --reporter=default --reporter=json --outputFile=artifacts/loop-full-final.json
node --experimental-transform-types scripts/model-task-evaluation-cli.mjs --mock --output artifacts/loop-model-task-final.json
npm run eval:agent-runtime -- --output artifacts/loop-agent-runtime-final.json
# 要求包括原生沙箱在内全部通过时：
npm run eval:agent-runtime -- --require-all --output artifacts/loop-agent-runtime-required.json
node scripts/eval-memory.mjs --split all --output artifacts/loop-memory-baseline.json
node scripts/eval-memory.mjs --hard-cases --split tune --output artifacts/loop-memory-tune.json
node scripts/eval-memory.mjs --hard-cases --split holdout --output artifacts/loop-memory-holdout.json
npm run build:client
npm run build:server
git diff --check
```

## 8. 未验证与边界

- 未验证真实供应商、真实社交平台、Wukong 内部执行协议及收费模型表现。
- 原生 Windows 沙箱缺组件；实际 UNC 网络共享、定制 NTFS ACL/文件占用组合、macOS/Linux 实机写入还需补验。
- 本轮原子文件替换及内容版本检查不宣称可对抗另一个不遵循锁协议的进程在最终检查与替换之间的极短竞争；助手自身同路径修改已串行化。
- PID 与持久账本用于恢复保护，未声称支持两个独立 Codia 服务同时共同写一个会话目录。
- 未处理原有全部跳过的上游契约，也未进行无关的全项目类型重构。已触及的新状态、接口及资源边界有明确类型和相关测试。
- 暂停、外部改动冲突拒绝、备份失败阻断属于有意行为变化；已有成果保留，不能将未经实机验证的环境描述为“零影响”。

## 9. 源码启动回归修复（2026-10-20）

用户终端启动时，服务端以 Node 24.21.0 直接加载 `server/index.ts`。崩溃日志确认新增 `RunController` 的构造函数参数属性触发 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，导致服务端退出；弹窗末尾的 GPU 状态不是此次退出原因。此前的编译构建和 Vitest 转译没有覆盖原生 Node 的 strip-only 加载限制，这是先前验收的缺口。

将参数属性改为显式成员声明及构造函数赋值，保持运行控制行为一致，不改变启动参数。新增 `tests/node-source-compatibility.test.ts`：子进程不继承 `NODE_OPTIONS`，使用普通 Node 直接导入并执行控制器；同时以 strip 模式解析服务端运行目录的 TypeScript。

本次验证：相关 3 个测试文件、17 项测试通过；Node 侧类型检查通过；765 个 TypeScript 文件原生 strip 语法检查通过。修复前普通 Node 导入可复现相同错误，修复后导入成功。该验证不等同于完整桌面启动及交互验收，也没有重新运行上述全量测试或打包。
