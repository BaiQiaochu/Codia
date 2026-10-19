# 第二轮任务、团队交付与自动化验证指南

本轮仅修改独立云副本，未提交、推送、发布或开启真实模型任务。以下自动化测试全部使用合成数据和临时目录；没有实际模型调用、外部派发、付费执行或外发消息。原有聊天与授权边界保留。

## 1. 任务与成果同步刷新

入口：侧栏「任务与成果」→「运行与成果」。

- 顶部「刷新」和每 5 秒的读取轮询都会刷新当前选中运行的登记产物、恢复检查点与团队交付卡，即使运行 ID 和会话没有变化。
- 版本比较的选择、恢复放弃确认以及人工复核草稿不会因同任务后台刷新被清空。真正切换任务/会话时会清理该任务上下文。
- 同一目标与不同目标的过期读取响应都会被忽略。部分读取失败保留此前可见内容，并分别提供「刷新登记产物」「刷新恢复记录」「刷新交付验收」。错误不会显示成成功的空列表。
- 记忆运行证据的导航使用完整的 `activity:ID`、`workflow:ID`、`company:ID` 定位当前保留的记录。不存在的历史记录明确提示不可用；打开证据不会新建或派发运行。

手工检查：
1. 打开一个真实运行，保持选择不变。先观察无文件，再让原任务登记文件；等下一轮刷新或点顶部刷新，文件应出现。
2. 保存两个内容快照并选择旧/新版本。点击顶部刷新，选择应保留。
3. 让同一运行从执行中进入受阻，恢复卡应更新。断开服务后点局部刷新，应有明确错误；恢复服务后局部重试即可。
4. 快速切换不同运行，较慢的旧请求不得覆盖新运行的成果与恢复状态。

## 2. 状态和时间的含义

- `in_progress` → 执行中；`reported` → 已汇报待验收；`completed` → 执行成功。自报完成与人工复核是两条不同事实。
- 原始状态保留为 `rawStatus`，详情也可见；失败、取消、排队与待审批跨来源统一。
- 新团队任务首次观察到 `in_progress` 才记录开始边界，首次进入 completed/failed/cancelled 才记录结束边界。仅分配和创建不冒充开始执行。
- 修改报告、验收项或产物不会改写已记录的开始/结束边界。旧记录缺少边界时保持未知，绝不拿 createdAt 或任意 updatedAt 回填。明确的推断来源显示为推断。
- 这些是本系统观察到的状态边界，不是对远端工具精确起止时刻的独立测量。

## 3. 团队逐项验收与成果导航

选中来源为 company 的任务，可见「团队交付验收」。

- 每项标准显示执行方自报结论和依据；人工结论及依据需用户逐项填写、明确保存。
- 自报通过不等于人工通过，人工记录也不会改变执行状态、自动派发依赖、发布或对外发送消息。
- 人工复核绑定报告、验收标准、自报依据、登记引用及可读取文件的 SHA-256。报告、标准或文件内容改变后，旧复核显示失效。
- 若后台更新发生时有未保存复核，草稿仍保留，但旧版本草稿不能直接保存。用户核对新内容后，明确点击「已核对新版本，保留草稿继续」才能继续。
- 成果优先用注册 fileId/resourceId；工具汇报会记录可信运行时原会话。原路径仅在该原会话已有登记表中精确匹配；无法关联的原路径和外部网址不会直接打开。
- 预览/导出复用既有资源授权和内容接口；原会话导航复用既有会话入口。无权限、已删除、未登记、超限或正在变化的资源给出明确状态，不提供可用成果链接，也不能将包含这些产物的交付记录为通过。
- 内容版本核对单文件上限 64 MiB，复用既有 canonical 路径与已打开文件句柄绑定校验。当前该安全核对仅支持 Linux 的 /proc 句柄验证；Windows/macOS 或句柄校验不可用时显示版本不可核对，并禁止记录通过。原会话的普通登记产物仍可通过现有资源面板查看。历史内容快照继续遵守原有平台能力与上限，不降级绕过验证。

手工检查：
1. 选中已汇报任务，核对标准、自报依据和人工未复核提示。
2. 打开登记成果预览，导出文件并打开原会话；这些操作应只读取结果。
3. 逐项填写人工结论与依据并保存。刷新应显示当前版本已复核。
4. 在原任务修改报告或成果内容，再刷新。旧复核应失效；相同大小、恢复原修改时间的文件内容变化也不能继承批准。
5. 保留一段未保存复核文字，刷新/模拟读取失败，文字应保留。更新产物后原草稿需重新核对当前版本。
6. 删除测试产物或使用当前身份无权访问的登记资源，确认没有可预览/导出的有效链接且不能保存通过。

## 4. 自动化健康与试跑

自动化卡新增最近运行健康、历史与结果会话，以及显式手动试跑。详细操作和边界见 [自动化健康说明](automation-health-v2-guide.md)；最终验收应覆盖成功、超时、错过计划、一次性失败停用、重启后 claimed 未完成五类状态。

试跑会真实执行已保存的任务，可能涉及模型费用或原任务外部操作。没有配置真实模型时不要为了测试点击试跑；使用下文合成回归即可。试跑仍使用既有权限和确认路径，不扩大授权。结果未知时先核对原结果，不无条件重放。

## 5. 可复跑的合成检查

任务/团队 focused 回归（8 文件，79 项通过）：

```sh
npx vitest run tests/task-console.test.ts tests/company-delivery-route.test.ts plugins/company/tests/task-delivery-review.test.ts plugins/company/tests/workflow-run-lifecycle.test.ts desktop/src/react/components/TaskConsolePanel.test.tsx desktop/src/react/components/TaskResultsPanel.test.tsx desktop/src/react/components/WorkflowRecoveryPanel.test.tsx desktop/src/react/components/CompanyDeliveryPanel.test.tsx --maxWorkers=2
```

前后端 focused TypeScript（均通过）：

```sh
npx tsc --noEmit -p artifacts/memory-verification/v2-task-delivery-ui.tsconfig.json
npx tsc --noEmit -p artifacts/memory-verification/v2-task-delivery-node.tsconfig.json
```

精确改动文件 lint 无 error，存在 35 条既有 TS 风格相关或扩展处 any/nocheck warning，不应称为零 warning。记录位于 `artifacts/memory-verification/v2-task-delivery-lint.log`。

修复前失败证据已保留：`v2-red-task-delivery.log`（13 失败）、`v2-red-company-delivery.log`（新路由缺失）、`v2-red-company-delivery-ui.log`（新 UI 尚未实现）。均位于 `artifacts/memory-verification/`。其中缺失模块/路由是先写集成测试得到的预期红态，不是假装已执行交互测试。

本轮没有运行全量测试、heavy build、真实桌面浏览器端到端、真实模型或真实第三方派发。自动化健康另有 13 文件、105 项专项回归通过，参见下节命令。任务/团队与自动化去重合计 21 文件、184 项通过；再复跑既有产物授权/快照回归 15 项，最终 22 文件、199 项通过。运行快照由记忆工作流维护，历史缺失环境不追填当前环境冒充证据。

## 6. 本组专属文件（任务/团队部分）

生产：
- `shared/task-console/records.ts`
- `shared/task-console/delivery.ts`（新增）
- `server/routes/task-console.ts`
- `server/routes/task-console-records.ts`（新增、供记忆 run picker 复用）
- `server/routes/task-console-delivery.ts`（新增）
- `plugins/company/lib/company-store.ts`
- `plugins/company/lib/company-service.ts`
- `plugins/company/tools/report.ts`
- `desktop/src/react/components/TaskConsolePanel.tsx`
- `desktop/src/react/components/TaskResultsPanel.tsx`
- `desktop/src/react/components/WorkflowRecoveryPanel.tsx`
- `desktop/src/react/components/CompanyDeliveryPanel.tsx`（新增）
- `desktop/src/react/utils/task-console-navigation.ts`（新增、供记忆证据导航复用）

测试：`tests/task-console.test.ts`、`tests/company-delivery-route.test.ts`、`plugins/company/tests/task-delivery-review.test.ts`、四个对应组件 `.test.tsx`。另复跑已有 `plugins/company/tests/workflow-run-lifecycle.test.ts`，没有修改该既有用例文件。

## 7. 剩余边界

- 自报、结构验证、人工复核各自有来源；没有额外模型或第三方独立语义验收。
- 任意外部 URL、未注册路径不是已验证可交付资源；需要先按现有资源登记流程登记。不会擅自下载外部资源、上传或分享。
- 历史记录受原活动账本保留范围影响；查询不声称覆盖所有已发生工作。
- 本组只读收集器不会为了找证据启用插件、创建团队、加载未知会话或派发任务。
- 文件版本是在读取时核对；活跃文件此后仍可能变化，应在交付前刷新。需要不可变文件时可按已有安全快照流程手动保存版本。

## 8. 自动化专属文件与回归

生产文件：
- `lib/desk/automation-health.ts`、`lib/desk/cron-store.ts`、`lib/desk/cron-scheduler.ts`
- `core/studio-cron-service.ts`（仅存储代理/绑定句柄）
- `hub/scheduler.ts`（requestId/结果透传与活动 ID 唯一性）
- `server/routes/desk.ts`（自动化相关区）
- `desktop/src/react/components/automation/AutomationHealthPanel.tsx`、`AutomationCard.tsx`、`AutomationJobsSection.tsx`、`AutomationPanel.module.css`、`automation-types.ts`

新增/更新测试：`tests/automation-health.test.ts`、`tests/automation-health-route.test.ts`、`tests/automation-result-reference.test.ts`、`tests/desk-cron-route.test.ts`、`desktop/src/react/__tests__/components/automation-health.test.tsx`。

```sh
npx vitest run tests/automation-health.test.ts tests/automation-health-route.test.ts tests/automation-result-reference.test.ts tests/automation-cron-store.test.ts tests/cron-store.test.ts tests/cron-reliability.test.ts tests/cron-scheduler.test.ts tests/desk-route-cron.test.ts tests/desk-cron-route.test.ts tests/scheduler-heartbeat-default.test.ts desktop/src/react/__tests__/components/automation-health.test.tsx desktop/src/react/__tests__/components/automation-error-smoke.test.tsx desktop/src/react/__tests__/components/automation-create-wiring.test.ts --maxWorkers=2
npx tsc --noEmit -p artifacts/memory-verification/v2-typecheck-automation.json
```

自动化红证据 `v2-red-automation-backend.log` / `v2-red-automation-ui.log` 是最初真实工具输出摘录；最初未保存完整 stdout，UI DOM 被工具截断。不是完整原日志，也没有将截断部分补造为实测结果。

最终复查修正：自动化孤儿领取记录只保留计划时间，不伪造执行开始；界面分别显示“执行时间未知”和计划时间。该用例先红后绿，证据为 `v2-{red,green}-automation-orphan-time.log`。

收尾按总集成配置复核：修正两处 `getByRole` 测试选项为精确名称正则（保留真实点击与断言）。`TaskConsolePanel.test.tsx` 14/14 通过；随后完整 `npx tsc --noEmit -p tsconfig.test.json` 通过。日志：`v2-task-console-final-test.log`、`v2-task-delivery-global-test-typecheck.log`。这是一轮全局测试类型检查，不是全量运行测试。


## 独立复查修复

- 自动化保存期间继续编辑：所有编辑字段具有独立 revision；成功回执只清除仍对应本次提交的字段。计划从 1 改 2 保存挂起，再改 3；标题在挂起时改回原值；提示继续修改，均不会被旧回执或随后刷新覆盖。保存中阻止重复保存，但可继续编辑。
- 团队产物内容核对：复用 `readSnapshotSource` 绑定原登记 canonical 路径和实际打开的 FD。若资源授权后祖先目录被替换为符号链接，停止读取且不返回可用状态、hash 或内容链接。缺少平台安全句柄校验时保持不可核对，不回退到较弱的路径比较。
- 两项均增加实际 React / 资源服务组合用例并先红后绿。日志：`v2-{red,green}-automation-save-race.log`、`v2-{red,green}-delivery-path-binding.log`。未访问真实敏感数据，路径置换仅使用测试临时目录中的合成文件。

独立复查修复后重跑：上述两个 focused 命令的去重并集，加 `tests/task-artifacts.test.ts`，22 文件、199/199 通过。全局 `tsconfig.test.json` 和相关前后端 focused 类型检查通过；相关 lint 0 errors；targeted diff-check 通过。最终日志 `v2-task-delivery-reviewed-final-tests.log`，类型日志 `v2-review-fixes-test-typecheck.log` / `v2-review-fixes-node-typecheck.log`。
