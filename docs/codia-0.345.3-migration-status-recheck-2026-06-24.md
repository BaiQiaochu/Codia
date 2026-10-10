# codia 0.345.3 迁移状态复查与兼容性报告

复查时间：2026-06-24
主程序目录：`E:\Codia`
原始代码目录：`E:\Codia\codia-0.345.3`
主程序入口：`desktop/bootstrap.cjs`，依据为主程序 `package.json` 的 `main` 字段。
技术栈识别：Electron 桌面端、React/Vite 前端、Node/Hono 后端、TypeScript、Vitest。

## 1. 复查结论

本轮复查围绕 UI、前端服务、后端 API、共享类型、桥接能力、依赖兼容和构建验证进行。当前未发现阻断级 P0/P1 未迁移项；0.345.3 的主要新增/调整能力已经在主程序中以“去品牌化、重构路径或兼容替代”的方式落地。

需要注意的非阻断风险有三项：

1. 工作区处于大规模 dirty/untracked 状态，发布前必须做一次 staged diff 审核，否则存在“本机可用、打包或他人机器缺文件”的发布一致性风险。
2. 原始 `lib/bridge/dingtalk-contract.ts` 在主程序中被折叠到 `lib/bridge/dingtalk-adapter.ts`，内部能力可用；若外部插件或旧代码直接 import 旧模块名，需要补一层兼容 re-export。
3. `@node-rs/jieba` 没有作为固定依赖纳入主程序，当前搜索分词走可选加载和 fallback。功能兼容可用，但如果要求与原始代码完全一致的中文分词效果，需要单独裁定是否引入原生依赖。

## 2. 文件级迁移清单

| 范围 | 原始文件数 | 主程序文件数 | 原始相对路径缺失数 | 结论 |
| --- | ---: | ---: | ---: | --- |
| `desktop` | 988 | 1786 | 195 | 多数为 UI 重构、去品牌化素材、旧 native helper 路径替换 |
| `server` | 73 | 88 | 0 | 后端路由与服务无原始相对路径缺失 |
| `lib` | 297 | 335 | 9 | 少量旧桥接/旧品牌/兼容模块被折叠或替代 |
| `shared` | 55 | 78 | 4 | `codia-*` 旧路径已迁移为 `codia-*` 兼容路径 |
| `core` | 148 | 158 | 0 | 核心层无原始相对路径缺失 |
| `packages` | 20 | 40 | 0 | 包层无原始相对路径缺失 |
| `tests` | 556 | 757 | 7 | 缺失主要为旧品牌或已重命名测试 |

缺失路径分类：

| 分类 | 代表项 | 状态 | 处理建议 |
| --- | --- | --- | --- |
| 去品牌化 native helper | `desktop/native/CodiaComputerUseHelper/*`、`CodiaWindowsSandboxHelper/main.cpp` | 已迁移为 `CodiaComputerUseHelper` / `CodiaWindowsSandboxHelper` | 无需恢复旧品牌路径 |
| 去品牌化素材 | `Butter.png`、`Codia.png`、`Kong.png`、`Ming.png`、`kong-banner.jpg`、`yuan-codia-*` | 主程序使用 Codia 图标和角色素材 | 保持主程序品牌资产 |
| UI 结构重组 | 原始 `desktop/src/react/ui/*`、部分 `app/*` 组件 | 主程序拆入 `components`、`settings`、业务面板 | 以主程序组件树为准 |
| 钉钉契约模块 | `lib/bridge/dingtalk-contract.ts` | 能力折叠进 `dingtalk-adapter.ts` | 若旧插件依赖模块路径，补兼容 re-export |
| Codia runtime 路径 | `shared/codia-root.ts`、`shared/codia-runtime-paths.*` | 已迁移为 `codia-root.ts`、`codia-runtime-paths.*` | 保持去品牌化路径 |
| 原始搜索依赖 | `shared/ollama-model-metadata.ts`、`@node-rs/jieba` 相关 | 主程序用模型目录/缓存和 fallback tokenizer | 若要求原始级分词，另立任务引入 |

## 3. 功能迁移状态

### 3.1 UI 与设置

| 功能项 | 主程序落点 | 状态 | 兼容性结论 |
| --- | --- | --- | --- |
| 会话列表单行/双行显示 | `desktop/src/react/components/SessionList.tsx`、`SessionList.module.css` | 已迁移 | 支持 `rowMode` 和 `sessionItemSingleLine` 样式 |
| 侧边栏 UI 偏好 | `shared/sidebar-ui-state.ts`、`server/routes/preferences.ts` | 已迁移 | 后端 patch 会规范化偏好字段 |
| 设置搜索索引 | `desktop/src/react/settings/settings-search-index.ts` | 已迁移 | 5 语言 locale key 已覆盖 |
| Markdown/预览底部留白 | `PreviewRenderer.tsx`、`Preview.module.css` | 已迁移 | 可避免底部内容被输入区遮挡 |
| 语言与地区设置 | `desktop/src/locales/*`、设置页 locale smoke 测试 | 已迁移 | 中文、英文等主程序语言文件存在对应设置文案 |

### 3.2 前端服务

| 功能项 | 主程序落点 | 状态 | 兼容性结论 |
| --- | --- | --- | --- |
| Resource event cursor | `desktop/src/react/services/resource-events.ts` | 已迁移 | 支持断线后按 cursor 追赶事件 |
| WebSocket 重连补事件 | `desktop/src/react/services/websocket.ts` | 已迁移 | 存在 `catchUpResourceEventsAfterReconnect` 与 foreground catch-up |
| 资源目录刷新 | `ResourceWatchRegistry` 相关前端消费 | 已迁移 | 与后端 `pendingRescan` 配合 |
| 设置 UI 搜索/多语言 | `settings-search-index.ts`、locale JSON | 已迁移 | 已通过设置搜索相关测试 |

### 3.3 后端与 API

| 功能项 | 主程序落点 | 状态 | 兼容性结论 |
| --- | --- | --- | --- |
| 偏好设置 patch | `server/routes/preferences.ts` | 已迁移 | 支持 sidebar UI prefs 规范化 |
| Resource IO 事件 | `server/routes/resource-io.ts`、`lib/resource-io/resource-watch-registry.ts` | 已迁移 | 路由和 watch registry 测试通过 |
| HTTP 路由安全 | `server/http/route-security.ts` | 已迁移 | 路由安全测试通过 |
| 会话/活动桥 | `server/routes/sessions.ts` 与 ActivityHub 相关逻辑 | 已迁移 | 当前后端构建通过，未见阻断错误 |
| 钉钉媒体桥接 | `lib/bridge/dingtalk-adapter.ts`、`capability-matrix.ts` | 已迁移 | 媒体/流式能力矩阵存在并有测试覆盖 |

### 3.4 运行时与 Shell

| 功能项 | 主程序落点 | 状态 | 兼容性结论 |
| --- | --- | --- | --- |
| Windows PowerShell 默认解析 | `lib/shell/shell-utils.ts`、`shell-profile.ts` | 已迁移 | 相关 resolver 测试通过 |
| Win32 sandbox `.ps1` 运行 | `lib/sandbox/win32-exec.ts` | 已迁移 | 与 shell resolver 兼容 |
| Codia runtime path | `shared/codia-runtime-paths.*` | 已迁移 | 去品牌化后保持运行时路径能力 |

## 4. 依赖兼容性检查

| 原始依赖 | 主程序状态 | 兼容性判断 |
| --- | --- | --- |
| `@mariozechner/pi-ai` | 替换为 `@earendil-works/pi-ai@0.74.1` | 已去品牌化替代 |
| `@mariozechner/pi-coding-agent` | 替换为 `@earendil-works/pi-coding-agent@0.74.1` | 已去品牌化替代 |
| `exceljs` | 主程序使用 `read-excel-file@9.0.6` | 文档/Excel读取兼容，复杂写入能力如需原始等价需单独验证 |
| `typebox` | 主程序使用 `@sinclair/typebox` | 正常兼容 |
| `node-telegram-bot-api` | 主程序为本地 Telegram client adapter | 兼容主程序桥接体系 |
| `@node-rs/jieba` | 可选动态加载，缺失时 fallback | 功能可用；原始级分词需裁定 |
| `@codemirror/language-data` | 未作为主程序固定依赖 | 当前主程序已移除完整编程模式，不构成阻断 |

已验证主程序安装依赖：

```text
@earendil-works/pi-ai@0.74.1
@earendil-works/pi-coding-agent@0.74.1
read-excel-file@9.0.6
```

## 5. 兼容性矩阵

| 维度 | 检查内容 | 结论 |
| --- | --- | --- |
| 技术栈版本 | Node/Electron/React/Vite/TS 构建链路 | `typecheck`、renderer/server build 均通过 |
| API 接口 | Preferences、Resource IO、Route Security、DingTalk bridge | 对应测试通过；旧 `dingtalk-contract.ts` 模块名需视外部插件兼容需求裁定 |
| 数据格式 | sidebar prefs、resource descriptor、resource events cursor | 已有规范化函数和回归测试 |
| 浏览器/设备 | Electron renderer Vite build | 构建通过；本轮未执行 Playwright 截图级视觉验收 |
| 用户体验一致性 | 会话列表、设置搜索、预览底部留白、多语言 | 关键 UI 逻辑测试通过；建议打包前补桌面视觉验收 |
| 去品牌化 | Codia/Codia 字符串扫描 | 源码仍保留少量 legacy alias/test fixture/兼容 header，不构成用户可见 UI 阻断 |

## 6. 验证记录

已执行并通过：

```powershell
npm run typecheck
```

结果：TypeScript 主工程和测试 tsconfig 校验通过。

```powershell
npx vitest run tests/sidebar-ui-state.test.ts tests/shell-utils.test.ts tests/shell-profile.test.ts tests/terminal-shell-resolver.test.ts tests/resource-watch-registry.test.ts tests/resource-io-route.test.ts tests/workspace-ui-preferences-route.test.ts tests/http-route-security.test.ts tests/debrand-ts-boundary.test.ts tests/pi-sdk-namespace.test.ts tests/pi-sdk-import-boundary.test.ts desktop/src/react/__tests__/services/resource-events.test.ts desktop/src/react/__tests__/editor/typography.test.ts desktop/src/react/settings/__tests__/settings-search-index.test.ts desktop/src/react/__tests__/settings/settings-locale-smoke.test.ts --reporter=dot
```

结果：15 个测试文件、82 个测试用例通过。

```powershell
npm run build:renderer
```

结果：Vite renderer 构建通过，2780 modules transformed。

```powershell
npm run build:server
```

结果：server bundle 构建通过；runtime imports 检查 313 个文件；`better-sqlite3 runtime smoke passed`；`verify-pi-sdk all checks passed`。

```powershell
npm run audit:mojibake
```

结果：扫描 2665 个文件，blockers=0，warnings=0。

```powershell
npx vitest run tests/debrand-ts-boundary.test.ts tests/desktop-literal-i18n-keys.test.ts tests/license-server-ts-boundary.test.ts tests/renderer-build-contract.test.ts --reporter=dot
```

结果：4 个测试文件、22 个测试用例通过。

## 7. 风险与解决方案

### RISK-001 大规模源码跟踪状态异常

- 风险：当前工作区存在大量 dirty/untracked/staged 变更，发布前如果不做 staged diff 审核，可能把临时文件、构建产物或未完成迁移一起带入安装包。
- 影响：发布一致性、回滚可控性、他人机器复现能力。
- 建议：打包前执行发布面向的文件清单审核；只纳入源码、资源、配置和必要构建脚本；临时报告、截图、日志、旧产物不要进入版本。

### RISK-002 钉钉旧契约模块路径兼容

- 风险：主程序内部已将原始 `dingtalk-contract.ts` 能力折叠到 adapter，但如果旧插件或外部代码直接 import `lib/bridge/dingtalk-contract.ts`，会出现模块路径不兼容。
- 建议：若需要旧插件零改动兼容，新增薄兼容模块，只 re-export 当前 adapter/capability 的常量和 credential normalization，不改变现有 adapter 逻辑。

### RISK-003 中文搜索分词原始级等价

- 风险：当前 fallback tokenizer 可用，但和 `@node-rs/jieba` 原始分词结果可能不完全一致。
- 建议：如果验收要求“搜索结果排序与原始代码强一致”，引入可选原生 jieba 并补平台安装/打包测试；如果只要求功能可用，保持 fallback 更稳。

### RISK-004 桌面截图级视觉验收未在本轮执行

- 风险：构建与单元测试通过不等于每个设置页/频道页视觉完全无偏差。
- 建议：打包前执行一次桌面启动 + Playwright 或 Electron 截图级验收，重点覆盖设置、频道、工作流、媒体生成、历史会话、授权页。

## 8. 后续裁定项

1. 是否需要给 `lib/bridge/dingtalk-contract.ts` 加旧模块兼容层。
2. 是否要求中文搜索与原始 `@node-rs/jieba` 达到原始级等价。
3. 是否在本轮审计后立即执行桌面视觉验收。
4. 是否在下一轮打包前先清理发布清单和暂存区。

## 9. 2026-06-24 执行结果

已按本报告中的可执行项完成两处低风险兼容修复：

1. 已新增 `lib/bridge/dingtalk-contract.ts` 旧契约兼容层，恢复原始代码的钉钉 Enterprise Stream URL 常量、base URL/endpoint URL 规范化、凭据规范化和自定义机器人字段拒绝逻辑。
2. 已让 `lib/bridge/dingtalk-adapter.ts` 复用 `dingtalk-contract.ts` 中的 URL 常量，避免 adapter 与旧契约模块后续漂移。
3. 已新增 `tests/dingtalk-contract-compat.test.ts`，覆盖旧模块导入、URL 常量、凭据 alias、endpoint query 保留和 webhook 字段拒绝。
4. 已修正 `lib/search/session-search-tokenizer.ts` 中的中文自定义词表，移除错误编码的中文词项。
5. 已修正 `tests/session-search-tokenizer.test.ts` 与 `tests/session-search.test.ts` 中的中文搜索样例，确保测试覆盖真实中文输入，而不是乱码文本。

本轮新增验证：

```powershell
npx vitest run tests/dingtalk-contract-compat.test.ts tests/dingtalk-adapter.test.ts tests/bridge-media-capabilities.test.ts tests/session-search-tokenizer.test.ts tests/session-search.test.ts --reporter=dot
```

结果：5 个测试文件、24 个测试用例通过。

```powershell
npm run audit:mojibake
```

结果：扫描 2667 个文件，blockers=0，warnings=0。

```powershell
npm run typecheck
```

结果：packages build、主工程 TypeScript、测试 TypeScript 校验通过。

```powershell
npm run build:server
```

结果：server bundle 构建通过；runtime imports 检查 313 个文件；`better-sqlite3 runtime smoke passed`；`verify-pi-sdk all checks passed`。

执行后剩余项：

1. `@node-rs/jieba` 仍保持可选依赖策略。本轮已提升 fallback 和可选 jieba 词表质量，但没有引入原生依赖，避免增加 Windows 打包风险。
2. 桌面截图级视觉验收仍未在本轮执行。
3. 工作区仍存在大规模 staged/dirty 状态，发布前仍需单独做文件清单审核。
