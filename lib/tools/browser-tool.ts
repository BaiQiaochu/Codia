// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../pi-sdk/index.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import { t } from "../i18n.ts";
import { toolOk } from "./tool-result.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { redactLogText } from "../log-redactor.ts";
import { summarizeBrowserActionParams } from "./browser-action-log.ts";
import { VISION_AUXILIARY_DISABLED_ERROR } from "../../core/vision-auxiliary-policy.ts";
import { modelSupportsImageInput } from "../../shared/model-capabilities.ts";
import {
  browserScreenshotMediaItem,
  persistBrowserScreenshotFile,
} from "../session-files/browser-screenshot-file.ts";

const BROWSER_ACTIONS = [
  "start", "stop", "navigate", "snapshot", "screenshot", "click", "type",
  "scroll", "select", "key", "wait", "evaluate", "show",
];

function browserError(rawMsg, details = {}) {
  return {
    content: [{ type: "text", text: t("error.browserError", { msg: rawMsg }) }],
    details: { ...details, error: rawMsg },
  };
}

export function createBrowserTool(getSessionPath, options = {}) {
  const browser = BrowserManager.instance();
  const screenshotEnabled = options.screenshotEnabled !== false;
  const actionValues = screenshotEnabled
    ? BROWSER_ACTIONS
    : BROWSER_ACTIONS.filter((action) => action !== "screenshot");

  const actionLogs = new Map();
  const ACTION_LOG_MAX_SESSIONS = 20;
  const ACTION_LOG_MAX_PER_SESSION = 200;

  function getActionLog(sessionPath) {
    return actionLogs.get(sessionPath) || [];
  }

  function logAction(sessionPath, action, params, resultSummary, error) {
    if (!actionLogs.has(sessionPath)) {
      actionLogs.set(sessionPath, []);
      if (actionLogs.size > ACTION_LOG_MAX_SESSIONS) {
        actionLogs.delete(actionLogs.keys().next().value);
      }
    }

    const log = actionLogs.get(sessionPath);
    log.push({
      ts: new Date().toISOString(),
      action,
      params: summarizeBrowserActionParams(action, params),
      result: error ? `ERROR: ${redactLogText(error)}` : redactLogText(resultSummary),
      url: redactLogText(browser.currentUrl(sessionPath)),
    });

    if (log.length > ACTION_LOG_MAX_PER_SESSION) {
      log.splice(0, log.length - ACTION_LOG_MAX_PER_SESSION);
    }
  }

  async function statusFields(sessionPath) {
    const running = browser.isRunning(sessionPath);
    const url = browser.currentUrl(sessionPath);
    const fields = { running, url };
    if (running) {
      fields.thumbnail = await browser.thumbnail(sessionPath);
    }
    return fields;
  }

  async function safeStatusFields(sessionPath) {
    try {
      return await statusFields(sessionPath);
    } catch {
      return {
        running: browser.isRunning(sessionPath),
        url: browser.currentUrl(sessionPath),
      };
    }
  }

  function resolveSessionPath(ctx) {
    return getToolSessionPath(ctx) || getSessionPath?.() || null;
  }

  function isExplicitTextOnlyModel(model) {
    return Array.isArray(model?.input) && !modelSupportsImageInput(model);
  }

  function screenshotObservationPrompt(details) {
    return [
      "Browser screenshot of the current page.",
      details?.url ? `URL: ${details.url}` : "",
      "Summarize the visible page state for a text-only agent.",
      "Include important text, layout, selected or active UI, visible errors, and clues for the next browser action.",
    ].filter(Boolean).join("\n");
  }

  async function adaptScreenshotForSession({ sessionPath, model, image, details }) {
    if (!isExplicitTextOnlyModel(model)) {
      return {
        content: [image],
        details,
      };
    }

    if (options.isVisionAuxiliaryEnabled?.() === false) {
      const msg = VISION_AUXILIARY_DISABLED_ERROR;
      return {
        content: [{ type: "text", text: t("error.browserError", { msg }) }],
        details: { ...details, visionAdapted: false, visionError: msg, error: msg },
      };
    }

    const bridge = options.getVisionBridge?.();
    if (!bridge?.prepare) {
      const msg = "vision auxiliary model is required for browser screenshots with the current text-only model";
      return {
        content: [{ type: "text", text: t("error.browserError", { msg }) }],
        details: { ...details, visionAdapted: false, visionError: msg, error: msg },
      };
    }

    try {
      const prepared = await bridge.prepare({
        sessionPath,
        targetModel: model,
        text: screenshotObservationPrompt(details),
        images: [image],
      });
      const notes = Array.isArray(prepared?.visionNotes) ? prepared.visionNotes.filter(Boolean) : [];
      const noteText = notes.length
        ? notes.join("\n\n")
        : "No visual observation was returned by the vision auxiliary model.";
      return {
        content: [{ type: "text", text: `Screenshot captured. Visual observation:\n${noteText}` }],
        details: { ...details, visionAdapted: true },
      };
    } catch (err) {
      const msg = err?.message || String(err);
      return {
        content: [{ type: "text", text: t("error.browserError", { msg }) }],
        details: { ...details, visionAdapted: false, visionError: msg, error: msg },
      };
    }
  }

  async function persistScreenshotFile(sessionPath, base64, mimeType) {
    if (!sessionPath || typeof options.registerSessionFile !== "function") return null;
    const gsapHome = options.getGsapHome?.() || options.getHanakoHome?.();
    if (!gsapHome) return null;
    return await persistBrowserScreenshotFile({
      gsapHome,
      sessionPath,
      base64,
      mimeType,
      registerSessionFile: options.registerSessionFile,
    });
  }

  return {
    name: "browser",
    label: t("toolDef.browser.label"),
    description: t("toolDef.browser.description"),
    parameters: Type.Object({
      action: StringEnum(actionValues, { description: t("toolDef.browser.actionDesc") }),
      url: Type.Optional(Type.String({ description: t("toolDef.browser.urlDesc") })),
      ref: Type.Optional(Type.Number({ description: t("toolDef.browser.refDesc") })),
      text: Type.Optional(Type.String({ description: t("toolDef.browser.textDesc") })),
      direction: Type.Optional(StringEnum(
        ["up", "down"],
        { description: t("toolDef.browser.directionDesc") },
      )),
      amount: Type.Optional(Type.Number({ description: t("toolDef.browser.amountDesc") })),
      value: Type.Optional(Type.String({ description: t("toolDef.browser.valueDesc") })),
      key: Type.Optional(Type.String({ description: t("toolDef.browser.keyDesc") })),
      expression: Type.Optional(Type.String({ description: t("toolDef.browser.expressionDesc") })),
      timeout: Type.Optional(Type.Number({ description: t("toolDef.browser.timeoutDesc") })),
      state: Type.Optional(Type.String({ description: t("toolDef.browser.stateDesc") })),
      pressEnter: Type.Optional(Type.Boolean({ description: t("toolDef.browser.pressEnterDesc") })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const sessionPath = resolveSessionPath(ctx);

        switch (params.action) {
          case "start": {
            if (browser.isRunning(sessionPath)) {
              logAction(sessionPath, "start", null, "already_running");
              return toolOk(t("error.browserAlreadyRunning"), { status: "already_running", ...await statusFields(sessionPath) });
            }
            actionLogs.delete(sessionPath);
            await browser.launch(sessionPath);
            logAction(sessionPath, "start", null, "launched");
            return toolOk(t("error.browserLaunched"), { status: "launched", ...await statusFields(sessionPath) });
          }

          case "stop": {
            if (!browser.isRunning(sessionPath)) {
              return toolOk(t("error.browserNotRunning"), { status: "not_running", running: false, url: null });
            }
            logAction(sessionPath, "stop", null, "closed");
            const sessionLog = [...getActionLog(sessionPath)];
            await browser.close(sessionPath);
            actionLogs.delete(sessionPath);
            return toolOk(t("error.browserClosed"), { status: "closed", running: false, url: null, actionLog: sessionLog });
          }

          case "navigate": {
            if (!params.url) return browserError(t("error.browserNavigateNeedUrl"));
            const result = await browser.navigate(params.url, sessionPath);
            logAction(sessionPath, "navigate", { url: params.url }, result.title);
            return toolOk(
              t("error.browserNavigated", { title: result.title, url: result.url, snapshot: result.snapshot }),
              { action: "navigate", ...await statusFields(sessionPath), title: result.title },
            );
          }

          case "snapshot": {
            const text = await browser.snapshot(sessionPath);
            return toolOk(text, { action: "snapshot", ...await statusFields(sessionPath) });
          }

          case "screenshot": {
            const model = ctx?.model || options.getSessionModel?.(sessionPath) || null;
            const textOnlyNeedsAuxiliary = isExplicitTextOnlyModel(model);
            const auxiliaryExplicitlyDisabled = options.isVisionAuxiliaryEnabled?.() === false;
            if (screenshotEnabled === false || (textOnlyNeedsAuxiliary && auxiliaryExplicitlyDisabled)) {
              const msg = screenshotEnabled === false
                ? "browser screenshot is unavailable for the current tool schema"
                : VISION_AUXILIARY_DISABLED_ERROR;
              return browserError(msg, {
                action: "screenshot",
                visionAdapted: false,
                visionError: msg,
              });
            }
            const { base64, mimeType } = await browser.screenshot(sessionPath);
            const screenshotFile = await persistScreenshotFile(sessionPath, base64, mimeType);
            const mediaItem = browserScreenshotMediaItem(screenshotFile);
            const details = {
              action: "screenshot",
              mimeType,
              ...await statusFields(sessionPath),
              thumbnail: base64,
              ...(screenshotFile || {}),
              ...(screenshotFile ? { screenshotFile } : {}),
              ...(mediaItem ? { media: { items: [mediaItem] } } : {}),
            };
            const image = { type: "image", mimeType, data: base64 };
            return await adaptScreenshotForSession({ sessionPath, model, image, details });
          }

          case "click": {
            if (params.ref == null) return browserError(t("error.browserClickNeedRef"));
            const snapshot = await browser.click(params.ref, sessionPath);
            logAction(sessionPath, "click", { ref: params.ref }, `clicked [${params.ref}]`);
            return toolOk(t("error.browserClicked", { ref: params.ref, snapshot }), { action: "click", ref: params.ref, ...await statusFields(sessionPath) });
          }

          case "type": {
            if (params.text == null) return browserError(t("error.browserTypeNeedText"));
            const snapshot = await browser.type(params.text, params.ref, { pressEnter: params.pressEnter ?? false }, sessionPath);
            logAction(sessionPath, "type", { ref: params.ref, text: params.text, pressEnter: params.pressEnter ?? false }, "typed");
            return toolOk(
              t("error.browserTyped", { target: params.ref != null ? ` to [${params.ref}]` : "", snapshot }),
              { action: "type", ref: params.ref, ...await statusFields(sessionPath) },
            );
          }

          case "scroll": {
            if (!params.direction) return browserError(t("error.browserScrollNeedDir"));
            const snapshot = await browser.scroll(params.direction, params.amount ?? 3, sessionPath);
            logAction(sessionPath, "scroll", { direction: params.direction, amount: params.amount }, "scrolled");
            return toolOk(
              t("error.browserScrolled", { dir: params.direction, snapshot }),
              { action: "scroll", direction: params.direction, ...await statusFields(sessionPath) },
            );
          }

          case "select": {
            if (params.ref == null) return browserError(t("error.browserSelectNeedRef"));
            if (!params.value) return browserError(t("error.browserSelectNeedValue"));
            const snapshot = await browser.select(params.ref, params.value, sessionPath);
            return toolOk(
              t("error.browserSelected", { ref: params.ref, value: params.value, snapshot }),
              { action: "select", ref: params.ref, value: params.value, ...await statusFields(sessionPath) },
            );
          }

          case "key": {
            if (!params.key) return browserError(t("error.browserKeyNeedKey"));
            const snapshot = await browser.pressKey(params.key, sessionPath);
            return toolOk(t("error.browserKeyPressed", { key: params.key, snapshot }), { action: "key", key: params.key, ...await statusFields(sessionPath) });
          }

          case "wait": {
            const snapshot = await browser.wait({
              timeout: params.timeout ?? 5000,
              state: params.state ?? "domcontentloaded",
            }, sessionPath);
            return toolOk(t("error.browserWaitDone", { snapshot }), { action: "wait", ...await statusFields(sessionPath) });
          }

          case "evaluate": {
            if (!params.expression) return browserError(t("error.browserEvalNeedExpr"));
            const result = await browser.evaluate(params.expression, sessionPath);
            const truncated = result.length > 30000
              ? `${result.slice(0, 30000)}${t("error.browserOutputTruncated")}`
              : result;
            return toolOk(truncated, { action: "evaluate", ...await statusFields(sessionPath) });
          }

          case "show": {
            await browser.show(sessionPath);
            return toolOk(t("error.browserShown"), { action: "show", ...await statusFields(sessionPath) });
          }

          default:
            return browserError(t("error.browserUnknownAction", { action: params.action }));
        }
      } catch (error) {
        const sessionPath = resolveSessionPath(ctx);
        logAction(sessionPath, params.action, params, null, error.message);
        return browserError(t("error.browserActionFailed", { msg: error.message }), {
          action: params.action,
          ...await safeStatusFields(sessionPath),
          ...(error.browserFatal || error.code === "BROWSER_SESSION_UNAVAILABLE" ? { fatal: true } : {}),
        });
      }
    },
  };
}
