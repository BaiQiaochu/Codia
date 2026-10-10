// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { saveMedia } from "../lib/download.ts";

const ADAPTER_ID = "comfyui";
const DEFAULT_BASE_URL = "http://127.0.0.1:8188";

function getProviderDefaults(ctx) {
  const allDefaults = ctx.config?.get?.("providerDefaults") || {};
  return allDefaults?.[ADAPTER_ID] || {};
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function taskIdFromPromptId(promptId) {
  const safe = String(promptId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `comfy_${safe}`;
}

function promptIdFromTaskId(taskId) {
  const match = String(taskId || "").match(/^comfy_(.+)$/);
  return match ? match[1] : taskId;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseWorkflow(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  if (typeof value === "object") {
    return cloneJson(value);
  }
  return null;
}

function loadWorkflow(params, defaults) {
  if (params.workflow) return parseWorkflow(params.workflow);
  if (defaults.workflow) return parseWorkflow(defaults.workflow);
  const workflowPath = params.workflowPath || params.workflow_path || defaults.workflowPath || defaults.workflow_path;
  if (workflowPath) {
    const resolved = path.resolve(String(workflowPath));
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  }
  return null;
}

function setInputPath(workflow, nodeId, fieldPath, value) {
  const node = workflow?.[nodeId];
  if (!node) return false;
  if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
  const parts = String(fieldPath || "text").split(".");
  let target = node.inputs;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
  return true;
}

function injectPrompt(workflow, params, defaults) {
  const promptNodeId = params.promptNodeId || params.prompt_node_id || defaults.promptNodeId || defaults.prompt_node_id;
  const promptField = params.promptField || params.prompt_field || defaults.promptField || defaults.prompt_field || "text";
  if (promptNodeId && setInputPath(workflow, String(promptNodeId), promptField, params.prompt)) return;

  const preferredKeys = ["text", "prompt", "positive", "caption"];
  for (const node of Object.values(workflow)) {
    if (!node?.inputs || typeof node.inputs !== "object") continue;
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(node.inputs, key) && typeof node.inputs[key] === "string") {
        node.inputs[key] = params.prompt;
        return;
      }
    }
  }

  throw new Error("ComfyUI workflow has no prompt text field. Configure providerDefaults.comfyui.promptNodeId/promptField.");
}

function injectNegativePrompt(workflow, params, defaults) {
  const negativePrompt = params.negative_prompt || params.negativePrompt || defaults.negative_prompt || defaults.negativePrompt;
  if (!negativePrompt) return;
  const nodeId = params.negativeNodeId || params.negative_node_id || defaults.negativeNodeId || defaults.negative_node_id;
  const field = params.negativeField || params.negative_field || defaults.negativeField || defaults.negative_field || "text";
  if (nodeId) {
    setInputPath(workflow, String(nodeId), field, negativePrompt);
  }
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const rawText = typeof res.text === "function" ? await res.text() : "";
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {}
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || rawText;
    throw new Error(`ComfyUI API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

function extractOutputs(history, promptId) {
  const entry = history?.[promptId] || history?.[String(promptId)] || history;
  const outputs = entry?.outputs || entry?.output || {};
  const files = [];
  for (const output of Object.values(outputs || {})) {
    for (const key of ["images", "gifs", "videos"]) {
      const arr = output?.[key];
      if (!Array.isArray(arr)) continue;
      for (const file of arr) {
        if (file?.filename) files.push(file);
      }
    }
  }
  return files;
}

async function downloadComfyFile(baseUrl, file, ctx, customName) {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", file.filename);
  if (file.subfolder) url.searchParams.set("subfolder", file.subfolder);
  url.searchParams.set("type", file.type || "output");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ComfyUI output: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "image/png";
  const dataDir = ctx.dataDir || path.dirname(ctx.generatedDir);
  const { filename } = await saveMedia(buffer, mimeType, dataDir, customName);
  return filename;
}

export const comfyuiAdapter = {
  id: ADAPTER_ID,
  name: "ComfyUI",
  types: ["image"],
  capabilities: {
    ratios: [],
    resolutions: [],
  },

  async checkAuth(ctx) {
    try {
      const defaults = getProviderDefaults(ctx);
      const baseUrl = normalizeBaseUrl(defaults.baseUrl || defaults.base_url);
      const res = await fetch(`${baseUrl}/system_stats`);
      return { ok: res.ok, message: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const defaults = getProviderDefaults(ctx);
    const baseUrl = normalizeBaseUrl(params.baseUrl || params.base_url || defaults.baseUrl || defaults.base_url);
    const workflow = loadWorkflow(params, defaults);
    if (!workflow) {
      throw new Error("ComfyUI workflow is not configured. Set providerDefaults.comfyui.workflow or workflowPath.");
    }

    injectPrompt(workflow, params, defaults);
    injectNegativePrompt(workflow, params, defaults);

    const clientId = params.clientId || params.client_id || defaults.clientId || randomClientId();
    const data = await jsonFetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    const promptId = data?.prompt_id || data?.promptId || data?.id;
    if (!promptId) throw new Error("ComfyUI did not return prompt_id.");
    params.baseUrl = baseUrl;
    params._comfyuiDefaults = { baseUrl };
    return { taskId: taskIdFromPromptId(promptId) };
  },

  async query(taskId, ctx) {
    const task = ctx.task || {};
    const defaults = task.params?._comfyuiDefaults || {};
    const baseUrl = normalizeBaseUrl(task.params?.baseUrl || task.params?.base_url || defaults.baseUrl || defaults.base_url);
    const promptId = promptIdFromTaskId(taskId);
    const history = await jsonFetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    const outputs = extractOutputs(history, promptId);
    if (!outputs.length) return { status: "pending" };

    const files = [];
    for (let i = 0; i < outputs.length; i++) {
      const filename = await downloadComfyFile(baseUrl, outputs[i], ctx, outputs.length > 1 ? `comfyui-${promptId}-${i + 1}` : `comfyui-${promptId}`);
      files.push(filename);
    }
    return { status: "success", files };
  },
};

function randomClientId() {
  return `codia_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
