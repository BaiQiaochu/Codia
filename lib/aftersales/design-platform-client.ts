// @ts-nocheck
function withTimeoutOptions(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(timeoutMs) };
  }
  return {};
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function safeParseResponse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

function getByPath(obj, pathSpec) {
  if (!pathSpec) return undefined;
  const parts = String(pathSpec).split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeImageUrls(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim());
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function buildAuthHeaders(config) {
  const apiKey = config?.designPlatform?.apiKey || "";
  if (!apiKey) return {};
  const headerName = config?.designPlatform?.apiKeyHeader || "Authorization";
  const prefix = config?.designPlatform?.apiKeyPrefix ?? "Bearer ";
  return { [headerName]: `${prefix}${apiKey}` };
}

function buildSubmitBody(task, config) {
  return deepMerge({
    workflowId: config?.designPlatform?.workflowId || "",
    prompt: task.promptBundle?.userPrompt || "",
    systemRole: task.promptBundle?.systemRole || "",
    negativePrompt: task.promptBundle?.negativePrompt || "",
    size: task.caseInfo?.size || "",
    rounds: task.caseInfo?.rounds || 1,
    metadata: {
      taskId: task.id,
      sourcePlatform: task.source?.platform || "",
      groupName: task.source?.groupName || "",
    },
  }, config?.designPlatform?.extraBody || {});
}

function isSuccessPayload(payload, config) {
  const statusValue = getByPath(payload, config?.designPlatform?.statusPath);
  if (statusValue == null) return true;
  const successValues = config?.designPlatform?.successValues || ["success", "completed", "done"];
  return successValues.includes(String(statusValue).toLowerCase());
}

function extractError(payload, config) {
  const value = getByPath(payload, config?.designPlatform?.errorPath);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 120000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...withTimeoutOptions(timeoutMs),
  });
  const payload = await safeParseResponse(res);
  return { res, payload };
}

function buildPollingUrl(template, taskId) {
  return String(template || "").replaceAll("{taskId}", encodeURIComponent(taskId));
}

async function pollAfterSalesResult(submitResult, task, config) {
  const polling = config?.designPlatform?.polling || {};
  const taskId = submitResult.externalTaskId;
  if (!polling?.enabled || !polling?.statusUrlTemplate || !taskId) return submitResult;

  const timeoutMs = Number(config?.designPlatform?.timeoutMs || 120000);
  const attempts = Number(polling.maxAttempts || 24);
  const intervalMs = Number(polling.intervalMs || 5000);
  const method = polling.method || "GET";
  const headers = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(config),
    ...(config?.designPlatform?.extraHeaders || {}),
  };

  for (let i = 0; i < attempts; i++) {
    const url = buildPollingUrl(polling.statusUrlTemplate, taskId);
    const { res, payload } = await requestJson(url, { method, headers, timeoutMs });
    if (!res.ok) {
      return {
        ...submitResult,
        ok: false,
        status: "failed",
        response: payload,
        error: `HTTP ${res.status}`,
      };
    }

    const imageUrls = normalizeImageUrls(getByPath(payload, config?.designPlatform?.imageUrlsPath));
    if (imageUrls.length > 0 || isSuccessPayload(payload, config)) {
      return {
        ...submitResult,
        response: payload,
        imageUrls,
        status: "success",
        ok: true,
      };
    }

    const errorMessage = extractError(payload, config);
    if (errorMessage) {
      return {
        ...submitResult,
        ok: false,
        status: "failed",
        response: payload,
        error: errorMessage,
      };
    }

    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    ...submitResult,
    ok: false,
    status: "failed",
    error: "polling timeout",
  };
}

export async function submitAfterSalesTask(task, config) {
  const submitUrl = config?.designPlatform?.submitUrl || "";
  const timeoutMs = Number(config?.designPlatform?.timeoutMs || 120000);
  const mode = config?.designPlatform?.mode || "dry-run";

  if (!submitUrl || mode === "dry-run") {
    return {
      ok: true,
      mode: "dry-run",
      status: "success",
      externalTaskId: null,
      imageUrls: [],
      request: task.promptBundle?.requestPreview || null,
      response: {
        simulated: true,
        message: "dry-run skeleton execution",
      },
    };
  }

  const headers = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(config),
    ...(config?.designPlatform?.extraHeaders || {}),
  };
  const body = buildSubmitBody(task, config);
  const { res, payload } = await requestJson(submitUrl, {
    method: config?.designPlatform?.submitMethod || "POST",
    headers,
    body,
    timeoutMs,
  });
  if (!res.ok) {
    return {
      ok: false,
      mode: "live",
      status: "failed",
      externalTaskId: payload?.taskId || payload?.id || null,
      imageUrls: [],
      request: task.promptBundle?.requestPreview || null,
      response: payload,
      error: extractError(payload, config) || `HTTP ${res.status}`,
    };
  }

  const initialResult = {
    ok: true,
    mode: "live",
    status: "success",
    externalTaskId: getByPath(payload, config?.designPlatform?.taskIdPath) || payload?.taskId || payload?.id || null,
    imageUrls: normalizeImageUrls(getByPath(payload, config?.designPlatform?.imageUrlsPath)),
    request: task.promptBundle?.requestPreview || null,
    response: payload,
  };
  const errorMessage = extractError(payload, config);
  if (errorMessage) {
    return {
      ...initialResult,
      ok: false,
      status: "failed",
      error: errorMessage,
    };
  }
  if (!initialResult.imageUrls.length && config?.designPlatform?.polling?.enabled) {
    return pollAfterSalesResult(initialResult, task, config);
  }
  return initialResult;
}
