# Codia mascot: standalone display

The installed desktop app needs no separately installed Live2D runtime, Python, Node development server, AI provider setup, user-home model files, or Internet connection to display Codia.

## Display modes

- With supported WebGL 2, WebAssembly and image decoding, the existing pinned Cubism SDK renders the real exported model and its existing nine-parameter welcome loop.
- While loading, if GPU safe mode is active, or if WebGL/runtime/model/shader loading fails, the existing Codia artwork is shown as an always-visible **static** neutral pose. It does not masquerade as Live2D animation. It has no peek/gaze CSS animation or offscreen initial transform.
- Reduced motion keeps the model in its neutral pose. A hidden/offscreen mascot pauses playback. Unmount/disable cancels work and releases its own GPU resources. Actual context restoration triggers reinitialization; unrecoverable devices continue to show the static character.
- GPU policy and Electron security settings are respected. No WebGL 1 substitution, GPU override, remote runtime, or security-setting workaround is used.

## Packaged resources

The Core script is a Vite-managed local resource. The framework, model JSON, MOC3 bytes, texture atlas and all 13 shader sources are carried by the lazy runtime chunk. The production resolver returns confined `codia-bundled:` resource keys regardless of the page URL or local-server port; these are map keys, never network URLs. Trusted inline binary data is decoded directly, not fetched through `data:` or `blob:`. Shader text is supplied directly through the reproducible SDK adapter.

The static image is the first neutral frame of the existing bundled Codia gaze-strip artwork, loaded as a normal local Vite image. No new third-party art or license agreement is introduced. Core, SDK upstream sources and licenses are preserved; reproduce/check the adapter with `node scripts/prepare-codia-live2d.mjs --check`. A changed/multi-atlas export fails closed until the explicit bundled map is updated.

## Checks

- Unit tests: `npx vitest run desktop/src/react/live2d/__tests__ desktop/src/react/__tests__/components/CodiaLive2DMascot.test.tsx desktop/src/react/__tests__/components/CodiaStaticMascot.test.tsx`
- Standalone native fixture: `node scripts/codia-live2d-react-fixture.mjs --build-only`, then load the printed `file://` URL in a normal Electron window with an isolated fresh profile. Run it with the existing Electron executable: `electron scripts/codia-live2d-native-fixture.mjs --profile /path/to/fresh-profile`. No fixture server is needed. This fixture uses the production component, assets and fallback.
- Test default startup, safety fallback, disabled/enabled, unmount/remount, missing model and recovery. On a supported device also exercise actual WebGL context loss/restoration and five enable/disable cycles. Its state panel identifies the actual renderer and error; unavailable WebGL is a valid static-display result, not proof of working animation.
- Optional custom-model authoring remains explicit: run the fixture server with `--model ...` and use `?assets=custom` (or its printed custom file URL). That transport is only for authoring; production never requires it.
- Final native packaged QA must use the rebuilt app under a fresh profile with no provider or user-home assets, and verify the visible character. A machine whose GPU policy blocks WebGL can only verify the static fallback; real animation needs a supported renderer and must not be claimed from that run.
