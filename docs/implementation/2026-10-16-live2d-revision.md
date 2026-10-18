# Live2D behavior revision

User revision on 2026-10-16: remove automatic static-image replacement. The previous requirements/plan/delivery descriptions have been updated accordingly.

## Intended behavior

- A successful model initialization continues to display the dynamic Live2D canvas.
- Initialization, asset loading, rendering and WebGL context failures show a clear error and a retry action, without rendering a static character.
- Retry creates a new initialization lifecycle; old/aborted results cannot replace the new lifecycle. Existing handles/listeners/observers are cleaned up.
- Manual disable hides the animation; manual enable starts it again. Reduced-motion remains an explicit control, not a switch to a static image.
- If the desktop GPU policy cannot be read, the welcome screen reports that error and retries the policy read. It does not invent a policy or bypass WebGL/security restrictions.

## Preservation boundary

The previous delivery was recovered from its exact Library archive and baseline; all 139 previously changed/new source hashes matched before edits. This revision is limited to Live2D/welcome UI, related fixtures/tests, and requirement/delivery documentation. Other workflow, approval, model/budget, memory, scheduling, artifact and evaluation enhancements must remain byte-identical to that delivery.

Real desktop/browser and hardware animation acceptance is not established by jsdom or mocked runtime tests. Prior provider/platform limitations remain unchanged.

## Live2D revision verification (2026-10-16, 20:36 UTC)

After removing automatic static replacement: **1161 files / 6341 tests passed; 13 files / 191 tests skipped; zero failures**. Renderer/test/Node typechecks, ESLint (zero errors; 1541 warnings), client production build and the 30/30 deterministic gate passed. Component tests cover initialization/load/draw errors, genuine retry initialization, stale results, cleanup, manual enable/disable and GPU-policy retry. Real hardware/browser rendering was not exercised. Previous Linux server-package/API smoke and model mock evidence are historical; backend sources are unchanged in this UI-only revision.
