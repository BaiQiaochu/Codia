# 记忆与经验：本地人工测试指南

本指南用于本地实施版本的交互验收，不需要模型、密钥或付费服务。种子脚本只生成明确标注的合成数据，不生成真实聊天、运行证据、人工核实结果或成功计数，也不会联网、读取应用凭据或修改模型配置。依赖安装 `npm ci` 可能需要访问 npm；这与离线种子脚本分开。

验证边界：本次新增的种子脚本已经通过 CLI 自动测试；本指南列出的界面操作仍需人工在真实浏览器中验收。真实模型效果、真实浏览器端到端交互没有因这些种子测试而被验证，不能据此宣称通过。

## 1. 准备环境

在本地代码根目录执行，使用 Node.js **>=24.12.0 且 <25**：

```sh
node --version
npm ci
```

安装与运行必须使用同一个符合要求的 Node 版本。若 `better-sqlite3` 报原生模块 ABI 不匹配，先切回正确 Node，再重新 `npm ci`；不要删除应用数据。下面的测试命令直接调用已安装的本地工具，不用 `npx` 临时下载。

本交付没有上传 GitHub、发布应用或操作你的电脑。请在你自己的本地代码副本中运行以下步骤。

## 2. 新建专用目录，启动一次，再关闭

务必使用全新、独立的数据目录，不要复制真实配置、聊天、数据库或密钥。目录名必须以 `codia-memory-test-` 开头，后面只用英文、数字、短横线或下划线。

macOS / Linux（bash / zsh）：

```sh
export CODIA_DEV_HOME="$(node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codia-memory-test-"));process.stdout.write(fs.realpathSync(dir))')"
printf '%s\n' "$CODIA_DEV_HOME"
npm run dev:web
```

Windows PowerShell：

```powershell
$env:CODIA_DEV_HOME = Join-Path $env:TEMP ("codia-memory-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $env:CODIA_DEV_HOME | Out-Null
Write-Output $env:CODIA_DEV_HOME
npm run dev:web
```

`dev:web` 实际读取 **CODIA_DEV_HOME**，启动器再将它传给子进程的 `CODIA_HOME`。只设置 `CODIA_HOME` 不足以隔离这条开发启动路径。全程保留同一终端中的 `CODIA_DEV_HOME`；换终端时重新设置为上面打印的绝对路径，不要重新生成一个目录。

打开终端打印的本地浏览器地址。在 Settings → Agent → Memory → 查看记忆（中文界面对应“设置 → 助手 → 记忆”），确认当前助手为 `codia`。新目录应为空，可先测试空状态。此流程无需配置模型、发起聊天或连接插件；不要为了准备夹具添加密钥。

随后在终端按 Ctrl+C，等服务端和 Vite 都结束、终端返回提示符。关闭本次测试页，确认没有仍使用这个测试目录的应用进程。脚本的确认参数表示你已经确认应用关闭，它不是自动进程探测器；不要在运行中的应用上执行。

首次启动负责生成 `agents/codia/config.yaml`。若脚本提示尚未初始化，应检查上面的启动日志与目录，不要复制真实用户配置来绕过检查。

## 3. 一条命令准备界面夹具

macOS / Linux：

```sh
node scripts/seed-memory-review.mjs --home "$CODIA_DEV_HOME" --confirm-test-home-and-stopped
npm run dev:web
```

Windows PowerShell：

```powershell
node scripts/seed-memory-review.mjs --home "$env:CODIA_DEV_HOME" --confirm-test-home-and-stopped
npm run dev:web
```

成功时显示 `status: seeded`，创建 3 条事实、2 条候选经验；`verifiedEvidenceCreated` 为 0：

- 事实 1：虚构角色偏好，状态为“有效”，但核实状态仍为未核实。
- 事实 2：虚构项目的主题色，状态为“有冲突”。
- 事实 3：初始化夹具前关闭应用的示例，状态为“候选”。
- 经验 1：重复运行种子脚本不应改变数量的测试假设，等待你实际执行验证。
- 经验 2：从事实 3 派生的候选，用于检验忘记来源后联动撤回。

所有事实和候选内容都有“合成测试数据”标签。事实来源是合成夹具标识，不是真实会话，不会制造可打开的聊天。经验 1 没有伪造来源，因此界面会提示缺少原始来源；你之后真实执行本地测试并亲自复核，才可以添加该次运行的结果。初始的运行证据、最近核实时间和反馈计数全部为空或零。

安全限制：

- 必须显式提供绝对路径 `--home` 及 `--confirm-test-home-and-stopped`，不使用隐含默认目录。
- 拒绝 `~/.codia`、`~/.codia-dev` 及其子目录，也拒绝目录/数据库链接和异常文件。
- 首次写入前检查事实、经验、旧版文本、删除历史等是否为空；已有数据不覆盖，也不混入夹具。
- 允许应用首次启动留下的空数据库。预检在临时副本中进行，避免 SQLite 只读连接给原目录生成边车文件。
- 完成后留下专用测试标记。再次运行返回 `already_seeded`，不增加条目，也不恢复你纠正、忘记或撤回的内容。
- 若存在未完成/损坏的标记或非空数据库，脚本会拒绝；不要删标记或改数据库硬重试。改用另一个全新测试目录，保留失败目录用于排查。

## 4. 界面主流程

重新进入 Settings → Agent → Memory → 查看记忆，检查当前助手仍为 `codia`。

### 事实：查看、纠错、忘记

1. 查看“记忆”“经验”“待核实”页。展开来源，核对合成标签、版本、项目范围、有效期、核实状态；合成来源不能被误认为真实对话。
2. 对事实 1 点“纠错”，把“简短回答”改成“先结论后说明”，保留“合成测试数据”和虚构角色说明。先试取消，再保存。保存成功后显示新版本；关闭重开后修改应保留。
3. 对事实 2 测试“标记冲突 / 确认无冲突”、指定项目范围、到期时间与“标记过期”。过期或冲突记录应显示不能直接作为可信事实使用的提示。
4. 对事实 3 点“忘记”，先试“取消忘记”，确认记录仍在；再“确认忘记”。事实应消失，经验 2 应联动撤回。它保留审查标识，来源内容可能被撤销说明替代。
5. 关闭应用、用同一 `CODIA_DEV_HOME` 重启。纠错与忘记应继续生效，旧事实不应复活。

### 经验：候选 → 人工运行证据 → 验证 → 启用 → 撤回

先选经验 1，直接点“验证候选”。此时没有真实核实结果，应提示缺少证据，状态仍为候选。不要为了让按钮通过而编造运行或勾选未做过的人工确认。

下面给出一个不调用模型的实际验证办法：

1. 记录当前界面中事实与经验数量，以及刚刚纠错/忘记后的状态；保存截图作为本地证据。
2. 关闭此测试目录的应用。再次运行种子脚本，把这次真实输出保存到测试目录中的日志。
3. 重启应用并对照前后界面，确认数量和修改未被重置；再保存截图。只有亲自检查过结果后，才填写核实表单。

macOS / Linux 示例（先确认应用已关闭）：

```sh
mkdir -p "$CODIA_DEV_HOME/review-evidence"
RUN_ID="manual-seed-repeat-$(date +%Y%m%d-%H%M%S)"
set -o pipefail
node scripts/seed-memory-review.mjs --home "$CODIA_DEV_HOME" --confirm-test-home-and-stopped 2>&1 | tee "$CODIA_DEV_HOME/review-evidence/$RUN_ID.log"
printf 'runId=%s\nplatform=' "$RUN_ID"
node -p 'process.platform'
npm run dev:web
```

Windows PowerShell 示例（先确认应用已关闭）：

```powershell
New-Item -ItemType Directory -Force -Path (Join-Path $env:CODIA_DEV_HOME "review-evidence") | Out-Null
$runId = "manual-seed-repeat-" + (Get-Date -Format "yyyyMMdd-HHmmss")
node scripts/seed-memory-review.mjs --home "$env:CODIA_DEV_HOME" --confirm-test-home-and-stopped 2>&1 | Tee-Object -FilePath (Join-Path $env:CODIA_DEV_HOME "review-evidence/$runId.log")
if ($LASTEXITCODE -ne 0) { throw "种子重复运行失败，请检查实际日志" }
Write-Output "runId=$runId"
node -p 'process.platform'
npm run dev:web
```

脚本输出应为 `already_seeded`，新增事实与经验均为 0。日志记录的是本次实际执行的结果，不是种子脚本提前生成的“成功证明”。界面前后状态仍须你亲自检查；本地路径只是证据引用，服务端不会替你证明文件内容真实。

进入经验 1 的“记录核实结果”：

- 运行标识：填写刚才真正执行的 `RUN_ID` / `$runId`。
- 证据引用：填写实际保存的日志路径；结果摘要中附上实际截图位置及观察到的前后数量。
- 结果：按观察选择成功、失败或未知。失败不能伪装为成功；未知不能晋升验证。
- 运行平台：填写命令实际返回的 `linux` / `darwin` / `win32`，不要填猜测值。
- 运行项目：保留 `synthetic-memory-review`。此标识是专用合成测试范围；不应换成真实项目。
- 应用版本、频道、依赖：候选未绑定这些限制时无需编造；若你修改了适用条件，则必须与本次实际环境一致。
- 只有本人检查过上述运行、日志和界面，才勾选“我已检查上述运行与证据”。

保存后核对结果与计数，再依次“验证候选”→“启用经验”→“确认启用”。初始候选不能直接启用。验证过的失败经验也可能被允许启用，因为它可以记录负面教训；计数必须仍是失败。

最后点“撤回经验”→“确认撤回”，确认状态变为已撤回，重开后仍保持。也可在撤回前测试“纠正内容与范围”：改版后应回到候选，旧版本证据不能用来验证新版本。

注意：合成经验只限 `synthetic-memory-review` 项目和记录的平台。Agent 的经验调用总开关关闭时，可以审查记录，但不应注入经验；启用单条记录不等于打开总开关。这份无模型流程验证状态治理，不证明真实对话召回或模型表现。

## 5. 边界情况清单

以下是待执行的人工验收清单，不是已经通过的结果：

- [ ] 空状态：另一个全新目录、不种子，三页均有清楚的空状态，没有假成功或异常计数。
- [ ] 网络/服务端错误：界面打开后停止本地服务端，点刷新，应显示加载失败而非“没有记忆”；重启后可以恢复。也可在开发者工具只阻断本地 `/api/memories/experiences`，检查其他页仍可读；完成后解除阻断。
- [ ] 重复点击：保存纠错、确认忘记、记录核实结果、验证和启用时快速双击；请求处理中按钮应锁定，没有重复记录或计数增长。
- [ ] 同一真实运行重复提交：相同操作重试不能累加独立成功；换操作标识却重报同一运行应收到重复运行提示。
- [ ] CAS 版本冲突：同一测试目录开两个标签页，A/B 都打开同一条记录；A 保存后，B 保留旧编辑稿再保存，应得到冲突提示、载入最新版本且保留编辑内容。人工核对后再保存，不能静默覆盖。
- [ ] 取消/关闭：取消纠错、取消忘记、取消核实、取消启用或撤回，不应产生写入；遮罩、Esc、关闭按钮行为一致。请求处理中关闭被锁定属于防重复写入机制，等待返回后再关闭。
- [ ] 焦点与布局：Tab/Shift+Tab 保持在对话框内，关闭后焦点返回；缩窄窗口或放大字体时内容可滚动、按钮不被遮挡。
- [ ] 重启：已纠正/忘记/撤回内容重启后不复活；重复运行种子也不重置它们。
- [ ] 证据不足：空字段、未人工确认、未知结果、不匹配环境不能把候选变为已验证。错误后原表单应可继续核对。
- [ ] 切换查看范围：当前助手和项目范围显示准确；合成项目经验不能被认为适用于真实项目。

夹具没有制造失败的模型提取任务，因此“重新排队提取”的真实模型执行不在此无模型流程中。队列显示为空是正常情况；不要把队列测试或读取次数当成模型成功率。

## 6. 自动检查与结果记录

种子安全测试：

```sh
node node_modules/vitest/vitest.mjs run tests/memory-review-seed.test.ts
node node_modules/eslint/bin/eslint.js scripts/seed-memory-review.mjs tests/memory-review-seed.test.ts
```

已实际执行的种子测试覆盖成功初始化、应用留下的空库、显式参数、四种默认目录/子目录拒绝、重复运行不累计、忘记后不复活、已有事实/经验不覆盖、旧版数据、链接目录和未完成标记。它们使用隔离临时目录和实际 CLI，没有对真实默认目录写入。

可继续运行现有治理与生命周期测试（它们不能替代真实浏览器验收）：

```sh
node node_modules/vitest/vitest.mjs run tests/memory-correction-routes.test.ts tests/memory-governance-routes.test.ts tests/experience-lifecycle.test.ts tests/memory-lifecycle-reliability.test.ts
```

记录每项实际观察、时间、Node/应用版本和截图；未执行标为“未测”，被阻塞标明原因，不要用自动测试通过代替人工勾选。

结束时关闭测试应用。想从头测试，重新创建一个全新 `codia-memory-test-*` 目录；无需改真实数据，也无需删除测试标记。保留日志便于报告问题；截图/日志分享前检查是否含其他窗口或真实私人内容。
