const DEFAULT_TASK_PATH = "/tasks/run";
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TEXT_CHARS = 100_000;

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function cleanObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function joinUrl(base: string, suffix: string): string {
  const normalizedBase = base.replace(/\/+$/g, "");
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function arrayOrEmpty(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function readRuntimeConfig(agentOrConfig: any = {}) {
  const root = agentOrConfig?.config ? agentOrConfig.config : agentOrConfig;
  const runtime = cleanObject(root?.runtime);
  const nestedRuntimeWukong = cleanObject(runtime?.wukong);
  const wukong = {
    ...nestedRuntimeWukong,
    ...cleanObject(root?.wukong),
  };
  return { root, runtime, wukong };
}

export function normalizeWukongRuntimeConfig(agentOrConfig: any = {}, engine: any = null) {
  const { runtime, wukong } = readRuntimeConfig(agentOrConfig);
  const globalWukong = cleanObject(engine?.config?.wukong);
  const target = cleanString(runtime?.target || wukong?.target);
  const enabled = target === "wukong" || wukong?.enabled === true || wukong?.runtimeEnabled === true;
  const gatewayUrl = cleanString(
    wukong.gatewayUrl
      || wukong.baseUrl
      || wukong.endpoint
      || globalWukong.gatewayUrl
      || globalWukong.baseUrl
      || globalWukong.endpoint,
  );

  return {
    enabled,
    target: enabled ? "wukong" : "local",
    gatewayUrl,
    token: cleanString(wukong.token || wukong.apiKey || wukong.accessToken || globalWukong.token || globalWukong.apiKey),
    skillId: cleanString(wukong.skillId || wukong.agentId || wukong.botId || globalWukong.skillId),
    workspaceId: cleanString(wukong.workspaceId || wukong.orgId || wukong.tenantId || globalWukong.workspaceId),
    taskPath: cleanString(wukong.taskPath || globalWukong.taskPath) || DEFAULT_TASK_PATH,
    healthPath: cleanString(wukong.healthPath || globalWukong.healthPath) || DEFAULT_HEALTH_PATH,
    timeoutMs: normalizePositiveInteger(wukong.timeoutMs || globalWukong.timeoutMs, DEFAULT_TIMEOUT_MS),
    fallbackToLocal: wukong.fallbackToLocal === true,
  };
}

export function isWukongRuntimeAgent(agent: any): boolean {
  return normalizeWukongRuntimeConfig(agent).enabled === true;
}

export function normalizeWukongRuntimeTaskInput(input: any = {}) {
  const text = cleanString(input.text ?? input.prompt ?? input.message);
  if (!text) {
    const err = new Error("text is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    metadata: cleanObject(input.metadata),
    conversation: cleanObject(input.conversation),
    source: cleanObject(input.source),
    attachments: arrayOrEmpty(input.attachments),
  };
}

export function normalizeWukongRuntimeResult(data: any) {
  if (typeof data === "string") {
    return { text: data, externalTaskId: null, status: "completed", toolMedia: [], raw: data, runtime: "wukong" };
  }
  const raw = data && typeof data === "object" ? data : {};
  const nestedResult = cleanObject(raw.result);
  const text = cleanString(
    raw.text
      ?? raw.reply
      ?? raw.output
      ?? raw.message
      ?? nestedResult.text
      ?? nestedResult.reply
      ?? nestedResult.output,
  );
  return {
    text,
    externalTaskId: cleanString(raw.taskId ?? raw.id ?? raw.externalTaskId ?? nestedResult.taskId) || null,
    status: cleanString(raw.status ?? nestedResult.status) || "completed",
    toolMedia: arrayOrEmpty(raw.toolMedia ?? raw.media ?? nestedResult.toolMedia ?? nestedResult.media),
    raw,
    runtime: "wukong",
  };
}

export function createWukongRuntimeAdapter({
  config,
  fetchImpl = globalThis.fetch,
}: {
  config: ReturnType<typeof normalizeWukongRuntimeConfig>;
  fetchImpl?: typeof fetch;
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Wukong runtime fetch implementation is unavailable");
  }

  async function requestJson(path: string, body: Record<string, any> | null = null) {
    if (!config.gatewayUrl) {
      const err = new Error("Wukong runtime gatewayUrl is required") as Error & { status?: number };
      err.status = 503;
      throw err;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (config.token) headers.authorization = `Bearer ${config.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(joinUrl(config.gatewayUrl, path), {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      } as RequestInit);
      const contentType = response.headers?.get?.("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      if (!response.ok) {
        const message = typeof payload === "string" ? payload : JSON.stringify(payload);
        throw new Error(`Wukong runtime request failed: ${response.status} ${message.slice(0, 300)}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async health() {
      return requestJson(config.healthPath);
    },
    async runTask(input: {
      text: string;
      agent?: any;
      conversation?: Record<string, any>;
      source?: Record<string, any>;
      metadata?: Record<string, any>;
      attachments?: any[];
    }) {
      const task = normalizeWukongRuntimeTaskInput(input);
      const agent = input.agent || {};
      const body = {
        text: task.text,
        agentId: cleanString(agent.id),
        agentName: cleanString(agent.agentName || agent.name),
        skillId: config.skillId || null,
        workspaceId: config.workspaceId || null,
        source: task.source,
        conversation: task.conversation,
        metadata: task.metadata,
        attachments: task.attachments,
        stream: false,
      };
      const payload = await requestJson(config.taskPath, body);
      return normalizeWukongRuntimeResult(payload);
    },
  };
}

export async function executeWukongAgentRuntimeTask({
  agent,
  engine = null,
  text,
  source = {},
  conversation = {},
  metadata = {},
  attachments = [],
}: {
  agent: any;
  engine?: any;
  text: string;
  source?: Record<string, any>;
  conversation?: Record<string, any>;
  metadata?: Record<string, any>;
  attachments?: any[];
}) {
  const config = normalizeWukongRuntimeConfig(agent, engine);
  if (!config.enabled) return null;
  const fetchImpl = engine?.getWukongRuntimeFetch?.()
    || engine?.wukongRuntimeFetch
    || globalThis.fetch;
  const adapter = createWukongRuntimeAdapter({ config, fetchImpl });
  return adapter.runTask({ text, agent, source, conversation, metadata, attachments });
}
