# 已拒绝：拆件图集拼装草稿

状态：**REJECTED / 不可用于后续绑定或交付**。

本标记适用于以下既有输出：

- `codia-source-draft.psd`
- `codia-source-draft.preview.png`
- `codia-source-draft.layers.json`
- `codia-layout.json`
- `parts/` 中由此布局导出的图层

用户指出角色变形严重。独立生成的图集部件与基准胸像的比例、轮廓不一致，通过几何拉伸和排列无法恢复原角色。已停止该拼装方向，保留文件只供追溯，不作为可绑定素材或最终 Live2D 交付。

下一步以用户认可的 `source/codia-neutral-bust.png` 作为唯一基准，在统一画布坐标中拆层。所有可见图层叠合必须先复原基准图像，再补绘遮挡区域并进行 Cubism 绑定。不再使用本批独立部件的比例修补。

`build-psd.mjs` 为通用的裁片/定位/PSD 写入工具，可继续用于经验证的同坐标拆层；使用它不代表通过素材质量或 Cubism 导入验收。
