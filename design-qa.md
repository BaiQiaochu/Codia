# Codia 新聊天页、助手配置与交互设计验收

**验收日期：2026-10-06**

## 对照基准

- 新聊天布局：`C:/Users/BAIQIA~1/AppData/Local/Temp/codex-clipboard-7115c6c0-337d-49e3-8d9c-f0f3ebd62c0c.png`
- 助手配置布局：`C:/Users/BAIQIA~1/AppData/Local/Temp/codex-clipboard-b3c8ff82-d8bf-4d7b-bcc4-f744ed982b00.png`
- 图片查看器清晰度：`C:/Users/BAIQIA~1/AppData/Local/Temp/codex-clipboard-1712f670-ed79-4395-9e9d-e97fca08ae3b.png`
- `@` 菜单位置：`C:/Users/BAIQIA~1/AppData/Local/Temp/codex-clipboard-3e33ba65-8228-49de-a3a6-208585908346.png`

附件中的红框和具体示例内容只用于说明位置与版式，不作为产品内容或指令来源。

## 对比图与实现截图

- `artifacts/codia-layout-qa/comparison-welcome.png`
- `artifacts/codia-layout-qa/comparison-assistant-settings.png`
- `artifacts/codia-layout-qa/welcome-1440x900.png`
- `artifacts/codia-layout-qa/welcome-1280x800.png`
- `artifacts/codia-layout-qa/welcome-1440x900-125pct.png`
- `artifacts/codia-layout-qa/welcome-low-height.png`
- `artifacts/codia-layout-qa/mention-menu-1440x900.png`
- `artifacts/codia-layout-qa/settings-1280x800.png`
- `artifacts/codia-layout-qa/assistant-settings-1280x800.png`

## 迭代记录

1. 首轮检查发现欢迎页根节点没有撑满滚动区，底部操作区与输入框之间出现大块空白，判定为 P1 布局问题。
2. 将欢迎页根节点和内容根节点设为占满可用高度，使紫色欢迎卡在上部空间居中，操作区停靠在输入框上方；低高度窗口继续由欢迎内容区滚动。
3. 按助手配置参考图重排为顶部助手选择区、身份主卡和下方编辑区；保留 Codia 品牌、真实头像、模型、身份类型和原有操作。
4. 最终多尺寸截图未发现 P0、P1 或 P2 视觉问题；控制台错误和 HTTP 错误均为 0。

## 最终视觉检查

| 检查项 | 结果 |
|---|---|
| 字体与层级 | 欢迎标题、快捷入口、设置分类、模块标签和助手身份卡层级清楚；图片查看器按钮使用高对比白字、深色底和清晰边框。 |
| 间距与布局 | 紫色欢迎卡在上部可用空间居中；快捷卡、Agent、工作空间和记忆控件紧挨输入框；助手身份卡采用左右分栏并在窄窗口自动纵向排列。 |
| 颜色 | 延续 Codia 固定浅紫主题，卡片、选中态、描边和阴影与现有品牌一致。 |
| 图片质量 | 猫咪和花朵素材保持比例与透明边缘；助手头像使用圆形裁切，图片提及支持缩略图。 |
| 文案与可读性 | `@` 菜单按“助手 / 图片 / 文件”分组；设置分类顺序为账号与助手、模型与能力、工作与扩展、系统与安全、通用与设备。 |
| 响应式 | 1440×900、1280×800、125% 缩放和 1100×650 低高度窗口均保留完整输入框；低高度时欢迎内容可滚动。 |

## 功能与运行检查

- `@` 输入会打开提及菜单；助手排在前面，图片和文件依据附件、会话文件及当前工作空间提供候选。
- 选择图片或文件会写入结构化文件引用；选择助手会在新会话同步目标助手并插入清晰的提及文本。
- 五类设置导航和顶部模块标签可真实切换，旧 `general`、`interface`、`about` 入口归一到“通用与设备 / 通用”。
- 本地模拟模型桌面冒烟覆盖媒体设置、文件预览、工作区操作、思维导图、项目技能和图片输入；未访问收费模型端点。
- 视觉检查报告：`artifacts/codia-layout-qa/report.json`，9 个状态，控制台错误 0，HTTP 错误 0。

final result: passed

---

# 侧栏账户卡与聊天完成状态配色验收

**验收日期：2026-10-10**

## 对照基准与实现证据

- 绿色完成状态参考：`C:/Users/baiqiaochu/OneDrive/文档/xwechat_files/wxid_t8157jcld54e22_d402/temp/RWTemp/2026-10/de47cc0545547707571554a95ea0e1ea/d0d30b9c20073f6fcbceb8612d0e79da.png`，2204 × 1235 像素。
- 账户区按钮参考：`C:/Users/baiqiaochu/OneDrive/文档/xwechat_files/wxid_t8157jcld54e22_d402/temp/RWTemp/2026-10/de47cc0545547707571554a95ea0e1ea/6a0c771479f6c3f1f430bc9f056a63b5.png`，390 × 135 像素。
- 实际聊天截图：`artifacts/codia-sidebar-theme-qa/chat-completion-1440x900.png`，1440 × 900 CSS 像素，deviceScaleFactor 1。
- 实际账户卡截图：`artifacts/codia-sidebar-theme-qa/account-card-1440x900.png`，215 × 66 CSS 像素，deviceScaleFactor 1。
- 同屏对照：`artifacts/codia-sidebar-theme-qa/comparison.png`，1600 × 1050 像素。
- 状态：Codia 雾紫主题、桌面宽度 1440、高度 900；隔离本地配置及本地模拟模型，完成一次真实 `read` 工具调用后展开执行过程。

## 对比结果

- **字体与层级：** 名称、说明文字、社交状态和设置图标保持现有字体层级；按钮并入卡片后没有挤压名称区域。
- **间距与布局：** 账户卡宽 215 像素，位于 240 像素侧栏内，左右各 12 像素边距；资料区和 69 像素操作区共享同一外框，三个点击区域保持独立。
- **颜色与主题：** 聊天完成状态从绿色改为主题计算出的浅雾紫，实测 `color(srgb 0.804392 0.718588 0.947686)`；错误态仍保留原有警示色。
- **图片与图标：** 沿用既有头像、Broadcast 和 Flower 矢量图标，没有添加近似素材或降质位图。
- **文案与可读性：** “账户与偏好设置”“社交状态”“设置”语义未改变，图标按钮继续提供独立 `aria-label` 和标题。
- **控制台：** 实际账户卡和工具完成状态采集过程中控制台错误为 0。

## 迭代记录

1. 首轮代码检查确认三个入口分别使用三张卡片，完成状态继承全局绿色语义色。
2. 将账户区改为一张侧栏等宽卡片，内部使用资料主按钮及独立操作按钮组；将完成状态的颜色覆盖限制在聊天颜色作用域。
3. 首次自动化工具状态采集未命中工具调用，调整本地模拟请求条件后重新采集；最终实际 `read` 工具完成标记呈浅雾紫，账户区边距和操作区尺寸符合目标。

没有剩余 P0、P1 或 P2 视觉问题。

final result: passed

---

# 输入框添加菜单与自动化记录验收

**验收日期：2026-10-10**

## 对照基准

- 输入框入口：用户提供的四角星按钮参考图。
- 添加菜单与技能列表：用户提供的 ChatGPT 桌面端参考图。
- 行为依据：OpenAI 官方的 composer slash commands、skills 和 apps 说明。

## 实机检查

- 四角星按钮在窄窗口和桌面布局中均保持显性，菜单从输入框上方展开，没有遮住发送按钮。
- 根菜单显示文件、文件夹、链接、插件、技能和工具；子菜单沿用雾紫描边、圆角和紧凑行高。
- 技能列表支持搜索，选中后以技能徽章写入输入框；插件列表只显示已加载插件，选中后以插件徽章写入输入框。
- 输入 `/` 时同时显示内置命令和全部启用技能；输入 `@` 时显示全部、文件、对话、助手四个标签，并按助手、对话、图片、文件分组。
- 左侧入口已改为“自动化记录”，使用历史时钟图标；面板读取所有助手的后台执行记录，空状态明确说明巡检、定时任务、子 Agent 与后台自动进程的覆盖范围。
- 交互过程中未出现渲染错误；开发服务首次连接前存在一条既有的短暂连接警告，连接建立后功能正常。

final result: passed
