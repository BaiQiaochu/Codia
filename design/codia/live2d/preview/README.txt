Codia Live2D 独立模型预览器

当前状态
本目录包含预览器源码、时间轴和已绑定九个核心参数的 motion3 动作文件。
真实 Cubism 模型位于 ../export；编辑工程为 ../Codia-rig-repair.cmo3。
原始工程、素材、candidate 导出及各检查点均保留。
不会加载官方示例角色、旧三帧图片或被否定的拼装稿作为替代。
主程序欢迎页已接入真实模型；本独立预览使用 .local-tools/live2d 中的 SDK 与编译物。
WebGL 2 不可用、GPU 安全模式或硬件加速关闭时，主程序继续显示 PNG 回退。
主程序的可发布 SDK 资源适配另见 third_party/live2d/README.md。

启动（在项目根目录执行）
node design/codia/live2d/preview/start.mjs

默认模型路径
design/codia/live2d/export/Codia.model3.json
将 Editor 导出的 .moc3、纹理和 model3.json 按原相对结构放在该目录。
圆框、身体遮挡和手指在框前的绘制关系由模型自身建立，预览器不以 CSS 位移伪造绑定。
也可指定模型：
node design/codia/live2d/preview/start.mjs --model "D:/path/to/Codia.model3.json"
仅监听 127.0.0.1，默认自动分配空闲端口，启动时打印 URL。
可选 --port 端口号；Ctrl+C 停止服务。

本地构建与类型检查
node design/codia/live2d/preview/start.mjs --build-only
node node_modules/typescript/bin/tsc -p design/codia/live2d/preview/tsconfig.json
使用项目已有 esbuild 和 TypeScript，不安装额外 npm 包，不修改根 package.json。
SDK 路径为 .local-tools/live2d/sdk/CubismSdkForWeb-5-r.5。
Core / Framework 及着色器均从本机 SDK 读取，不向模型供应商发请求。

Cubism 5.3 Offscreen 兼容
Core、Framework 和着色器统一使用上面的官方 5-r.5 目录；其 Core 变更记录为 06.00.0001，包含离屏不透明度修复。
预览创建 WebGL 2 上下文，不回退 WebGL 1。Framework 的离屏合成会调用 blitFramebuffer，WebGL 1 无法完成该绘制。
HeadGroup 的分组裁剪与 Iris 的局部眼眶裁剪均交给官方渲染器，预览不扁平化分组、不合并或重写遮罩。
导出必须保留 Cubism 5.3 的 Offscreen 数据；仅看到 Editor 中的分组开关不能证明实际 moc3 中已有分组。
载入真实模型后，debug-state.rendering 给出实际 Core 版本、WebGL 上下文、离屏组 owner/opacity/masks，可核对 HeadOpeningMask 是否保留。
本次核心循环的实际模型、WebGL 2 画面及桌面尺寸检查见 ../validation/core-loop-runtime-review.json。
验收范围是当前九参数循环；不表示所有 33 个参数都有绑定，也不表示扩展动作已完成。

动作文件
Codia.peek.motion3.json 是官方 Version 3 参数曲线格式。
10 秒、30 fps、Meta.Loop=true，9 个参数，来自主程序与预览共用的时间轴。
重新生成：node design/codia/live2d/preview/export-motion.mjs
已加入 ../export/Codia.model3.json 的 FileReferences.Motions.Idle。
官方 Framework 不会仅凭 Meta.Loop=true 自动循环 CubismMotion；其他宿主需显式 setLoop(true)，并使用 MotionBehavior_V1（或外部十秒时钟）维持相同循环周期。
主程序和本预览直接使用共用十秒时钟，不受官方默认 MotionBehavior_V2 额外补间帧影响。
真实 SDK 动作文件检查见 ../validation/motion-runtime.json。
预览器当前直接按相同时间轴设置参数，不叠加随机待机动作、鼠标跟随或未校验的物理配置。

参数约定
ParamBodyRise 0..1；ParamHandLReach/RReach 0..1；ParamHandLGrip/RGrip 0..1；
ParamAngleX/Y/Z -30..30；ParamEyeBallX/Y -1..1；
ParamEyeLOpen/ROpen 0..1；ParamHairSwing -1..1。
L / R 指角色自身左右，即角色左手在画面右侧。
头部左上/右上以观看者方向为准。
实际导出缺少参数时，界面显示缺失项，且不会向 Cubism 注册虚构参数。

真实绑定采样
加载实际 .moc3 后只采样一次，不在动画循环中重复验证。
对每个约定参数采样最小值、默认值、最大值；分别使用模型默认姿势与减少动态效果的抬起静止姿势。
比较实际可绘制网格的顶点、不透明度、可见性、颜色和绘制顺序，包含可见网格使用的遮罩。
Cubism 5.3 模型同时采样 Offscreen 组不透明度、颜色、顺序，以及仅供 Offscreen 组使用的遮罩；结果以 changedOffscreens 记录所属部件。
区分“存在且会改变模型”“存在但未检测到变化”“缺失”，不会只凭 ID 存在宣称绑定完成。
采样结束或失败时恢复所有参数、部件不透明度并重新计算模型；不覆盖已保存参数，也不推进时间轴。
这不是像素级验收：复杂组合绑定可能不在两种采样姿势中生效，纹理透明区或遮挡也可能让网格变化肉眼不可见。
离屏组有变化也不能证明其内容实际露出；嵌套组遮挡、最终裁剪边缘和虹膜双层遮罩仍需用真实导出逐帧查看。
响应结果不能代替朝向、比例、遮挡、双手抓框与动画质量的视觉检查。
机器可读结果：JSON.parse(document.getElementById('binding-validation').textContent)。
state 为 not-loaded / checking / checked / error，parameters[].status 为 responsive / no-change-detected / missing。
canvas 的 data-binding-validation 同步 state；减少动态效果下也保留结果。
验证算法回归：node --test design/codia/live2d/preview/validate-bindings.test.mjs

预览交互
自动播放与主程序共享 9 个核心参数的时间轴：头部 X 为 ±24、Y 为 18；眼球 X 为 ±0.65、Y 为 0.5。
头部 Z、左右眨眼与头发 4 个扩展参数仅保留手动检查和响应采样，不参与自动循环。
加载状态只按 9 个核心参数判断；完整 13 项采样仍保留，JSON 中的 coreSummary 单独报告核心结果。
现有 Codia.peek.motion3.json 不会被预览加载；需要动作文件时重新运行 export-motion.mjs，可生成同步的 9 参数动作。
支持暂停/继续、拖动到指定时刻、重新加载导出文件。
减少动态效果会停在双手抓框、正视前方的姿势，并跟随系统偏好。
切到后台或舞台离屏时停止动画帧，回来继续原时刻。
离开页面释放模型、纹理、动画帧及 Framework；WebGL 丢失时显示错误。
Core startUp 在每页只注册一次日志回调；不调用 cleanUp 后再次 startUp，避免 Core 6.0.1 的 WASM 回调表重复注册。
initialize 与 startUp 分开检查；卸载模型时移除当前 WebGL 上下文的 Offscreen 容器，每次绘制使用 try/finally 配对 beginFrameProcess/endFrameProcess。

建模调试（不修改模型文件）
“单参数手动检查”为每个约定参数提供滑杆；范围及默认值来自真实 .moc3，缺失参数禁用。
首次拖动快照当前全部参数，停止循环，只调整所选参数；重置默认值和抬起静止姿势也保持暂停。
“恢复自动循环”返回原时间轴；拖动时间轴也会退出手动模式。减少动态效果仍阻止自动播放。
“圆框接触点标定”先暂停当前姿势，再由用户点击模型画面上的固定框沿目标，显示 L/R 十字。
十字保存为模型空间坐标，随画布尺寸和模型矩阵正确投影，但不会跟随手部变形；可用于检查身体上升时手是否漂移。
标记不代替真实圆框、遮罩或手指绑定；重载模型清除标记。
JSON.parse(document.getElementById('debug-state').textContent) 可读取手动值、模型矩阵、CanvasInfo 和标记坐标。
默认 CubismModelMatrix 使用 setHeight(2.0)，再叠加 model3.json 的 Layout；当前画布为正方形，无额外投影缩放。
屏幕归一坐标 (u,v) 转 NDC 为 (2u-1,1-2v)，乘实际模型矩阵的逆矩阵得到目标模型坐标。
原图 1254×1254 不是 WebGL 坐标；源像素映射须结合实际导出的 CanvasInfo 尺寸、原点与 PixelsPerUnit 核对，不能直接用图片百分比替代。
调试算法回归：node --test design/codia/live2d/preview/debug.test.mjs
时间轴与状态回归：node --test design/codia/live2d/preview/timeline-status.test.mjs

本地证据导出
“保存当前画布 PNG”会同步重绘当前姿势后读取画布，支持暂停、静止或手动参数姿势。
“录制两轮 WebM · 20 秒”仅使用 canvas.captureStream 与 MediaRecorder，不申请屏幕、摄像头或麦克风权限。
录像独立从第 0 秒运行同一条真实 SDK 时间轴，连续两个 10 秒循环；自动播放时只驱动 9 个核心参数。
录制期间冻结画布像素尺寸并暂时禁用调参，完成或取消后恢复时间、播放/暂停、减少动态效果、手动参数和接触点标记状态。
切到后台、卸载模型、编码或绘制失败时明确中止，不导出半段视频；按钮在录制中可用于取消。
PNG 与 WebM 只含模型画布，不含页面背景和 SVG 标定十字。WebM 的透明度表现取决于浏览器编码器和播放器。
完成后仅将页面生成的画布成果 POST 到同源 /evidence，保存至 design/codia/live2d/validation/visual，再提供普通 HTTP 下载链接。
此接口仅存在于独立 loopback 预览服务；检查 Origin/Host，只接受 PNG（最多 32 MiB）和完整两轮 WebM（最多 64 MiB），校验文件头与完成元数据。
文件名由服务端自动生成，不接受客户端路径；每份成果附带 JSON 元数据，记录模型路径、SHA256、大小、画布尺寸与录制时长。保存本身不会自动认定视觉验收；人工检查记录独立保存。
取消、部分录制或上传中断不写文件。保存失败时可重试内存中的完整成果，无须再次录制；网络响应丢失时重试可能产生另一份文件，不谎报已经落盘。
界面只有收到本地写入确认才显示“已保存到本机”及完整路径。普通下载链接仅为另存副本，浏览器下载失败不会丢失已落盘成果。
JSON.parse(document.getElementById('evidence-state').textContent) 提供 recording / saving-local / saved-local / error 等状态及格式、大小、时长、磁盘路径信息。
动作组列表按真实采样显示 9 个核心和 4 个扩展的响应，不将参数存在当作完成视觉验收。

已保存录像检查
访问 /review.html 可检查已保存录像。当前采样修复后的两轮录像为 codia-20261006T150849692Z-4024d65b-af65-4a3a-a415-af7a5599a2d0.webm。
也可使用 /review.html?file=<本预览生成的WebM文件名>，文件仍只能来自 validation/visual。
检查页只使用真实 video 播放器，不加载 Cubism、不重放参数曲线、不修改文件。
提供指定关键时间按钮、完整播放/暂停与从头播放；HTTP Range 支持本地跳转。
review-state JSON 报告真实 duration/currentTime/presentedFrameTime、videoWidth/videoHeight、seekable/buffered、掉帧计数及 MediaError。
录制时 JSON 的 elapsedSeconds 单独显示；不能将它当成浏览器实际解码时长。

许可
官方 SDK 保留在 .local-tools 中，适用 Live2D 自身许可，不受 Codia 项目许可证状态影响。
下载来源、SHA256 和许可页快照见 .local-tools/live2d/downloads/download-manifest.json。
本独立工具不会自动将 SDK 或 Editor 加入正式应用发布。

当前素材与绑定范围
九参数涵盖身体升降、独立左右手伸出与局部握持、头部 X/Y、虹膜 X/Y。
手部保留原有握拳图，不含分离手指或真正张开手掌的关键形状。
头部 Z、左右眨眼和头发摆动未检测到响应，不参与自动循环。
保留原脸部比例与源图像素；源图外缘少量白粉抠图残留未重绘。主程序使用官方 mipmap 缩小采样，避免欢迎页小尺寸的明显颗粒和断线。
