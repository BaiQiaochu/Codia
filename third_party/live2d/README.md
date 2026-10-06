# Codia / Live2D integration sources

The `cubism-web-5-r.5` directory contains the official Cubism SDK for Web 5-r.5
Framework sources, WebGL shaders, Core redistributables, and original notices.
Source: https://www.live2d.com/en/sdk/download/web/
Framework: https://github.com/Live2D/CubismWebFramework

These components retain their upstream licenses. Core uses the Live2D Proprietary
Software License; Framework uses the Live2D Open Software License. Read the SDK's
LICENSE.md and NOTICE.md, including the release-license conditions, before release.
They are not relicensed under Codia's Apache license. No sample character is included.

Reproduce the local renderer resources after `npm ci`:

```sh
node scripts/prepare-codia-live2d.mjs
node scripts/prepare-codia-live2d.mjs --check
```

The script reads only the committed source here. It does not download anything or
depend on `design/`, `.local-tools/`, Cubism Editor, or a local Java installation.
The output includes source hashes and keeps licenses next to Core and shaders.
The Framework bundle has two documented lifecycle adaptations: abort outstanding
shader fetches on disposal, and release a single context without disposing other
mounted models. Upstream files remain byte-for-byte unchanged.

## Enable after export review

1. Put the actual Editor export in `desktop/src/assets/codia/live2d/model/`:
   `Codia.model3.json`, its `.moc3`, and each atlas at the exact relative path in
   `FileReferences.Textures`. Do not put PSD or CMO3 files in renderer assets.
2. Resolve assets with `resolveCodiaLive2DAssets(window.location.href, serverPort)`.
   HTTP renderers use their local asset directory; `file://` Electron uses the
   existing loopback `/desktop/assets/` route for fetchable model/shader data.
   Core is a Vite URL import and stays a local renderer script; Framework is a
   lazy renderer chunk. No CSP expansion or new server endpoint is needed.
3. In WelcomeScreen, wrap the existing fallback in `CodiaLive2DMascot`, provide
   the resolved assets and explicitly set `enabled` after model review. Pass GPU
   safe mode / disabled hardware acceleration through its props. The component
   is disabled by default and WelcomeScreen is deliberately unchanged for now.
4. Size the component's square canvas in the hero art area. The exported model
   owns its circular clipping and hand ordering. Do not apply the old sprite CSS
   translation, gaze keyframes, or a whole-canvas circular clip to the real rig.

The component handles cancellation, resize, reduced motion, visibility, context
loss and restoration. It drives only BodyRise, two hand reaches, two hand grips,
AngleX/Y, and EyeBallX/Y. Hair, AngleZ, blinking, physics and motion files are not
driven. Parameter presence is checked; visual keyform quality must be reviewed in
the real export. A successful load is not a claim of visual acceptance.

## React / WebGL2 lifecycle fixture

```sh
node scripts/codia-live2d-react-fixture.mjs --model path/to/Codia.model3.json
```

This builds an isolated page using the actual React component, loader and SDK,
then serves only local assets on an automatically assigned loopback port. It
prints both an HTTP URL and an Electron `file://` URL (the local server must stay
running for model/shader fetches). No welcome-page switch or user settings change
is made. `--build-only` builds without starting a server.

Use the controls to disable/re-enable, unmount/remount, lose/restore the WebGL
context, and resize. “连续启停 5 次” exercises five real component reloads and
reports each transition. Core startup and its WASM logging callback remain
registered once per page; zero model users dispose Framework resources, and the
next user reinitializes them without another Core startup. The status panel
records renderer state and uncaught errors.
Check pixels as well as status: a `live2d` state alone does not prove correct
clipping or absence of a blank frame. Shader and offscreen pools are removed for
only the disposed context; each draw pairs the SDK's begin/end frame operations.
