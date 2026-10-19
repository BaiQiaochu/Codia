# 记忆与经验治理 v2：本地复测说明

本轮使用合成 SQLite、Hono HTTP 组合测试及 React 组件测试。未调用真实模型，未上传仓库，未运行远程发布。应用实际桌面交互仍需用户本地复测；这里没有声称浏览器/真实模型 E2E 已验收。

## 1. 正确性修复与边界

- 旧 GET `/api/memories/export` 与 POST `/api/memories/import` 均返回 HTTP 410，错误码 `unsafe_memory_format_retired`。它们不能保留范围、到期时间及撤回账本，继续导入会不安全。本轮直接退役，明确拒绝，未提供替代的完整备份/恢复功能。
- 原 v1/v2 JSON 不是完整恢复包；不得把它或单个数据库覆盖操作描述为安全备份恢复。经验、生命周期撤回记录、reset 标记、原子恢复与合并冲突处理均需完整方案后才能支持。
- 实时 Agent 事实搜索、经验记录/召回使用可信运行环境构造器。项目来自真实工作目录；频道来自会话元数据；依赖取本地已安装 package.json 或 package-lock 的精确版本，绝不把 `^1.0.0` 之类范围冒充安装版本。Node 使用运行时实际版本。后台经验提取与重试使用独立历史构造器，只读取当时记录的环境，不以当前版本、频道或 manifest 补填旧历史。
- 没有可信频道时，普通记忆搜索排除所有频道事实；已有受信频道范围的显式跨频道功能及其原授权边界保持不变，模型不能以缺少范围绕过隔离。
- 模型工具参数不能覆盖项目、频道或依赖环境。未知环境继续拒绝受约束经验，并返回缺少字段/不匹配原因。
- 普通新建会话与本地隔离运行在会话创建完成、执行前记录环境快照。ActivityHub 与其持久层保留快照，后续状态更新不改写历史；独立会话环境旁文件供后续提取使用。外部运行不伪造本地环境。
- 用户手工设置的会话项目分类 `projectId` 保留不变；新会话记忆范围另存 `memoryProjectId`，后台摘要不把显示分类误作记忆适用范围。
- 恢复旧会话不会补写当前环境快照。同一会话恢复后若项目、频道、平台、应用版本或依赖变化，保留首快照并标记混合环境；该会话暂停滚动摘要及事实/经验学习，不将未知范围退化为全局候选。单纯 run ID 改变不算环境变化。请新建会话继续学习。
- 旧运行没有快照或只有当前会话工作目录时，历史环境显示未知。即使旧 cwd 当前仍存在，也不会重新推算历史项目 ID。不能以当前目录或用户填写值补成可信历史记录。

## 2. 本地界面复测

从助手设置打开“记忆与经验”。请优先使用专用测试助手，避免对重要事实进行不可逆的遗忘操作。

1. 记忆、经验、待核实三个页面应按服务端页码加载。选择每页记录、前后翻页；页签总数及待核实总数跨页保持正确，不是仅当前页长度。
2. 输入搜索词，按项目、来源、状态、更新日期筛选。项目选择同时显示可读名称与真正的 `workspace:` 标识；历史项目搜索应能找到初始建议之外的项目。来源 ID 可直接检索。
3. 来源分组下展开事实来源，读取精确消息证据。消息 ID、角色与文本来自已有源会话；有证据 hash 时显示是否仍匹配。找不到源消息或源已变更须明确提示，不能伪造引用。来源会话跳转仍保留。
4. 只勾选想处理的事实，先查看批量预览再确认。取消不写入。批量只作用于选中快照；人为制造一个版本变更后提交，未冲突项可成功，冲突项显示逐条结果及当前版本。经验没有“批量无条件启用”。
5. 经验选择“记录核实结果”，选择本助手真实运行。run ID、时间、状态、项目、环境及证据引用只读，来自服务端执行记录。查看任务详情或已有结果摘录核对实际证据。
6. 仅在确实采用当前版本经验时点击“本次实际采用了这条经验”。刷新或重复提交同一运行不会增加采用计数。选择运行、普通检索或模型声称使用都不会记为采用。
7. 核实结果仍需人工明确勾选确认。运行仍在进行时不能保存为成功；未知结果不能让候选晋级。内容改版后旧版本证据不能验证新版本。验证候选、启用经验仍是独立动作。
8. 若使用外部手工证据，页面必须明确显示“人工提供，未自动解析”，与已有运行记录区分；人工仍负责核对其真实性。
9. 把普通会话手工移入自建项目，再恢复会话，分类应保持不变。旧会话没有快照时仍显示未知；同一会话换环境继续时学习暂停且首快照不被重写，新开会话可记录新环境。
10. 查看提取任务的分页、状态与重新排队。预算及保留面板的暂停说明、恢复条件、额度/未知费用等由本轮维护模块展示，重新排队不代表已成功执行。

## 3. 新增接口概要

现有 settings.read/settings.write 边界沿用，新路由内部仍检查范围；经验人工核实/采用另检查真实用户 principal，模型身份不能制造人工确认。

- GET memories、memories/experiences、memories/extractions：`limit` 1–100（默认 25）、`offset`、`q`、`projectId`、`source`、`status`、`from`、`to`、`reviewOnly`。返回当前页、总数及待核实总数。
- GET memories/projects：按真实项目 ID 搜索与分页；项目数据为事实、经验、提取记录中的已知项目，不把任意展示名当项目 ID。
- GET memories/runs：本助手已有执行记录；未知历史环境不补填。GET memories/:id/evidence：精确消息预览，最多 20 条来源，每会话最多扫描 8 MiB，每条展示最多 8,000 字符。
- POST memories/batch：显式确认、选中 ID 及版本，逐条 CAS 结果；不是全有或全无的批量事务。
- POST memories/experiences/:id/attempt：真实 run ID、版本、明确实际采用确认；按运行/内容版本幂等。
- POST memories/experiences/:id/review：`recorded_run` 从服务器替换环境、状态和证据引用；`external_manual` 明确记录来源性质。任何模式都不自动启用经验。

## 4. 确定性测试

所有命令在项目根目录执行，无模型、无网络、无用户真实数据库：

```sh
npx vitest run tests/memory-governance-v2.test.ts tests/memory-runtime-context-v2.test.ts tests/memory-run-snapshot-v2.test.ts tests/memory-governance-routes.test.ts tests/memory-routes.test.ts tests/memory-correction-routes.test.ts tests/experience-lifecycle.test.ts tests/experience-tools.test.ts tests/experience-tools-toggle.test.ts tests/memory-hybrid-query.test.ts tests/memory-lifecycle-reliability.test.ts tests/channel-memory-lifecycle-integration.test.ts tests/activity-hub.test.ts tests/fact-provenance.test.ts tests/engine-build-tools-session-files.test.ts --maxWorkers=1
npx vitest run desktop/src/react/settings/overlays/MemoryViewer.test.tsx desktop/src/react/settings/overlays/MemoryGovernanceV2.test.tsx --maxWorkers=1
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.test.json
```

前次基础集验证：后端 15 个测试文件、131 个用例通过；UI 2 个测试文件、30 个用例通过，合计去重 161 个用例。实际合成 SQLite 中 10,000 条事实的 HTTP 请求只返回当前 10 条，并验证全局总数与待核实总数。未测浏览器大数据性能。

修复前红灯与 focused 运行日志保存在 `artifacts/memory-verification/`。UI 组件测试及维护/预算测试由对应模块提供；综合报告应按去重后的最终运行结果计数，不把多轮同名用例累加。

## 5. 保留与限制

- 原聊天不会因遗忘一条记忆而被删除。防复活撤回记录、reset 标记与幂等收据继续保留。
- 检索/注入普通事件可从活动表归档至收据表；统计与重试去重同时查询收据，不能为了缩小账本删掉必要防重记录。历史缺时间的事件不伪造时间后删除。
- 实时环境快照的 manifest 解析目前支持 Node/npm 的已安装依赖与 package-lock。其他生态缺少已验证版本时保持未知，不会猜测。
- 历史运行摘要或日志为空时如实显示未记录；运行成功状态不是经验有因果贡献的证明。人工确认仍不可省略。

## 6. 独立审查后的组合回归

```sh
node node_modules/vitest/vitest.mjs run tests/memory-historical-environment-v2.test.ts tests/memory-session-project-v2.test.ts tests/memory-search-channel-scope.test.ts tests/memory-run-snapshot-v2.test.ts tests/session-coordinator.test.ts tests/memory-experience-ticker-retry.test.ts tests/memory-runtime-context-v2.test.ts --maxWorkers=1
```

这组 7 文件、50 用例通过。其中历史摘要先失败后重试仍使用原频道/依赖/应用版本；相同会话恢复后环境变化暂停事实和经验学习；普通新会话写首快照，旧会话无快照不补；人工项目分类恢复后不变；提取中途环境变化时提交守卫阻止事实落库。运行返回环境只来自本次本地执行捕获，外部运行返回自报环境一律不可升级为可信。该组与上述基础集有重复，不累加作独立总数。

新增红灯日志：`v2-red-historical-environment.log`、`v2-red-resume-project.log`、`v2-red-session-project.log`、`v2-red-returned-run-snapshot.log`。组合绿灯日志：`v2-green-history-integration.log`。

本轮审查修复最终检查：`tsconfig.node.json` 与 `tsconfig.test.json` 均通过；上述生产/测试相关文件 ESLint 为 0 errors、19 warnings（既有宽类型与 nocheck 等提示），日志为 `v2-history-{node-typecheck,test-typecheck,eslint}.log`。独立审查还复跑原人工项目恢复覆盖用例及真实自动化运行环境持久化链路，均通过。没有执行完整备份恢复、真实模型调用或上传发布。

## 7. 人工确认的版本边界补测

人工核实确认现在绑定经验 ID、修订版本及实际证据草稿；新版本在首次 DOM 提交时就没有旧确认，不等待后续 effect 清空。任何已提交证据字段发生实质变化都需匹配该草稿的人工确认，提交函数另做守卫。采用回包绑定经验 ID、内容版本和运行 ID，旧回包不能使新内容显示已采用；仅反馈计数改变修订版本时保留原内容的采用状态。原冲突用例的即时断言未放宽，未增加等待时间。

```sh
node node_modules/vitest/vitest.mjs run desktop/src/react/settings/overlays/MemoryApprovalV2.test.tsx desktop/src/react/settings/overlays/MemoryGovernanceV2.test.tsx desktop/src/react/settings/overlays/MemoryViewer.test.tsx --maxWorkers=1 --no-cache
node node_modules/vitest/vitest.mjs run tests/memory-activity-host-evidence-v2.test.ts --maxWorkers=1
```

UI 组合为 3 文件 44 用例通过；新增 14 项覆盖 passive effect 前 layout 阶段、外部证据字段变化和晚到采用回包。独立审查的 10 项原始红测也原样变绿。真实自动化环境持久化链路另由新增 `memory-activity-host-evidence-v2` 用例复跑。审批红绿与独立回验日志为 `v2-{red,green}-approval-boundary.log`、`v2-review-approval-*.log`。
