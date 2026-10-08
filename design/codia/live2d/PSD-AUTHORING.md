# Codia 分层 PSD 打包

## 当前流程：单一原图同坐标拆层

使用 `source/codia-neutral-bust.png` 作为唯一输入，运行：

```powershell
node design/codia/live2d/build-aligned-psd.mjs
```

`source-separation.json` 保存原图坐标多边形。每个可见像素只分配给一个具名图层，没有选中的像素及原图完全透明像素的不可见 RGB 保留在 `Base_Unassigned`。所有图层保持原始 1254×1254 画布和 `(0, 0)` 坐标，**不缩放、不平移、不拉伸、不重画**。

输出 `codia-source-aligned.psd`、`codia-source-aligned.preview.png` 和 `codia-source-aligned.validation.json`。验证会解码 PSD 图层后重新合成，分别报告重叠可见像素、可见像素差异、Alpha 差异及不可见 RGB 差异；不会把 PSD 合成预览的白底编码误当图层像素变化。

这是可见像素的初步选区拆分，边界还需人工细化；没有补全被遮挡区域，也没有建立 Live2D 绑定。像素一致不代表已经具备转头/抓框的可用层级。

## 已拒绝的旧流程：独立 atlas 部件拼装

**以下仅保留工具使用记录，不要重新使用 `codia-layout.json` 作为建模原稿。其 PSD 与预览已被拒绝，详见 `REJECTED.md`。**

此工具把已经批准的透明 PNG 拆件图集按整数坐标裁出，根据明确指定的尺寸进行几何缩放，并放到同一张画布的指定位置。它不会补画、抠图、绑定网格或生成 Live2D 模型。

## 依赖与运行

依赖安装在独立目录，不改变 Codia 主项目依赖：

```powershell
npm install --prefix .local-tools/live2d/authoring --save-exact --no-audit --no-fund ag-psd@31.0.2 pngjs@7.0.0 sharp@0.35.5
node design/codia/live2d/build-psd.mjs --layout design/codia/live2d/codia-layout.json --out design/codia/live2d/codia-source.psd --layers-dir design/codia/live2d/parts
```

`--atlas <路径>` 可覆盖清单的默认图集；单个图层的 `atlas` 优先级最高。`--preview <路径>` 可指定合成预览。存在输出文件时默认拒绝覆盖，主动添加 `--overwrite` 才会覆盖输出；任何输入文件都不可作为输出。

## 清单格式

坐标均为整数像素，原点在左上角。`layers` 和每个分组的 `children` 都按照 Photoshop **从上到下**的显示顺序填写，最上面的图层放在数组最前面。只有普通 RGBA 图层和穿透分组，不使用效果、智能对象或混合颜色。

以下仅说明格式，数值必须根据实际生成的图集调整，不是已完成的模型清单：

```json
{
  "version": 1,
  "order": "top-to-bottom",
  "atlas": "codia-parts-atlas.png",
  "canvas": { "width": 1024, "height": 1024 },
  "layers": [
    {
      "name": "HandLeft",
      "children": [
        {
          "name": "HandLeft_Fingers",
          "crop": { "x": 0, "y": 0, "width": 128, "height": 128 },
          "position": { "x": 680, "y": 700 }
        }
      ]
    },
    {
      "name": "Head",
      "children": [
        {
          "name": "HairFront",
          "crop": { "x": 128, "y": 0, "width": 384, "height": 384 },
          "position": { "x": 320, "y": 100 }
        },
        {
          "name": "FaceBase",
          "atlas": "codia-face-atlas.png",
          "crop": { "x": 0, "y": 0, "width": 384, "height": 384 },
          "position": { "x": 320, "y": 240 },
          "hidden": false
        }
      ]
    }
  ]
}
```

- 清单中的图集路径相对于 JSON 所在目录；命令行路径相对于当前工作目录。
- `crop` 是图集中的取样区域，`position` 是取样区域左上角在 PSD 画布上的位置。
- 不提供 `size` 时裁出的所有 RGBA 通道逐字节保留。不使用 Canvas，避免 Canvas 预乘 Alpha 改变半透明边缘。
- 可显式提供 `"size": { "width": 300, "height": 250 }` 按 Lanczos3 缩放部件，修正生成图集中独立部件的比例；缩放后的 RGBA 逐字节写入 PSD，并保留透明通道。不要把非等比缩放误认为已经完成的网格修形。
- 允许多张透明 PNG 图集；要求 PNG 为 8 位且存在真实透明像素，不能把棋盘格背景当透明。
- 同组图层名称不能重复；图层不能越出源图或目标画布。可用 `hidden: true` 保留不参与预览的备用图层。
- `HandLeft` 指角色自身左手，在正视图的画面右侧。

## 输出

1. `codia-source.psd`：具名分组、普通 RGBA 图层及完整合成图的标准 RGB/8 位 PSD。
2. `codia-source.preview.png`：透明背景的合成预览。
3. `codia-source.layers.json`：图集与 PSD 校验值、每层来源、裁剪/放置坐标与透明像素信息。
4. 可选 `--layers-dir`：按 PSD 图层順序导出的独立透明 PNG。

写入前会重新解码 PSD，逐层精确核对名称、位置、可见性和 RGBA。合成图核对透明通道及不透明像素；PSD 合成图的半透明像素采用白色底色编码，存在舍入误差，独立图层不受影响。另存 PNG 预览保留原始合成像素。此校验不等同于已经通过 Cubism Editor 的实际导入检查；还需在 Editor 导入 PSD，检查 Parts、ArtMesh 和合成效果，随后进行绑定。

为了可用 FREE 版继续编辑，建模时建议控制在 100 张 ArtMesh、30 个 Parts、30 个参数和 50 个变形器以内；运行时纹理图集可设为一张 2048×2048。源 PSD 画布不必等于最终纹理图集大小。
