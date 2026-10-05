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
