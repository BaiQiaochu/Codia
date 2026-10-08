/**
  *
 *
 * Pi SDK 调用 tool.execute(toolCallId, params, signal-, onUpdate-, ctx-) 时，
  * */

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参- * @returns {string|null}
 */
export function getToolSessionPath(ctx) {
  return ctx?.sessionManager?.getSessionFile?.() ?? null;
}

function isAbortSignalLike(value) {
  return value
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

/**
 * Normalize both supported calling conventions:
 * execute(toolCallId, params, signal, onUpdate, ctx)
 * execute(toolCallId, params, runtimeCtx)
 *
 * @param {object|null|undefined} signalOrRuntimeCtx
 * @param {object|null|undefined} piCtx
 * @returns {{ ctx: object, hasExplicitCtx: boolean }}
 */
export function normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx) {
  if (piCtx && typeof piCtx === "object") return { ctx: piCtx, hasExplicitCtx: true };
  if (
    signalOrRuntimeCtx
    && typeof signalOrRuntimeCtx === "object"
    && !isAbortSignalLike(signalOrRuntimeCtx)
  ) {
    return { ctx: signalOrRuntimeCtx, hasExplicitCtx: true };
  }
  return { ctx: {}, hasExplicitCtx: false };
}

/**
 * @param {object} [ctx] - Pi SDK tool execute context.
 * @returns {string|null}
 */
export function getToolSessionCwd(ctx) {
  return ctx?.sessionManager?.getCwd?.() ?? null;
}
