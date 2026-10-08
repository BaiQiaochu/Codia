export const DINGTALK_STREAM_API_BASE_URL = "https://api.dingtalk.com/v1.0";
export const DINGTALK_REST_API_BASE_URL = "https://api.dingtalk.io/v1.0";

export const DINGTALK_BOT_CALLBACK_TOPIC = "/v1.0/im/bot/messages/get";
export const DINGTALK_STREAM_OPEN_PATH = "/gateway/connections/open";
export const DINGTALK_ACCESS_TOKEN_PATH = "/oauth2/accessToken";
export const DINGTALK_DM_SEND_PATH = "/robot/oToMessages/batchSend";
export const DINGTALK_GROUP_SEND_PATH = "/robot/groupMessages/send";

export const DINGTALK_STREAM_OPEN_URL = buildDingTalkUrl(
  DINGTALK_STREAM_API_BASE_URL,
  DINGTALK_STREAM_OPEN_PATH,
);
export const DINGTALK_ACCESS_TOKEN_URL = buildDingTalkUrl(
  DINGTALK_REST_API_BASE_URL,
  DINGTALK_ACCESS_TOKEN_PATH,
);
export const DINGTALK_DM_SEND_URL = buildDingTalkUrl(
  DINGTALK_REST_API_BASE_URL,
  DINGTALK_DM_SEND_PATH,
);
export const DINGTALK_GROUP_SEND_URL = buildDingTalkUrl(
  DINGTALK_REST_API_BASE_URL,
  DINGTALK_GROUP_SEND_PATH,
);

const CUSTOM_ROBOT_FIELDS: Record<string, string> = {
  webhook: "custom robot webhook URL",
  webhookUrl: "custom robot webhook URL",
  webhookToken: "custom robot webhook access token",
  webhookSecret: "custom robot webhook signing secret",
  robotWebhook: "custom robot webhook URL",
  robotToken: "custom robot webhook access token",
  token: "custom robot token",
  secret: "custom robot signing secret",
};

export interface DingTalkBridgeCredentials {
  appKey: string;
  appSecret: string;
  robotCode: string;
  restBaseUrl: string;
  streamOpenUrl: string;
}

function cleanString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return text || "";
}

function hasValue(value: unknown) {
  return cleanString(value).length > 0;
}

export function normalizeDingTalkBaseUrl(value: unknown, label = "DingTalk base URL") {
  const raw = cleanString(value);
  if (!raw) throw new Error(`${label} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function buildDingTalkUrl(baseUrl: string, path: string) {
  const base = normalizeDingTalkBaseUrl(baseUrl, "DingTalk REST base URL");
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${base}/`);
  return url.toString();
}

export function normalizeDingTalkEndpointUrl(value: unknown, label: string) {
  const raw = cleanString(value);
  if (!raw) throw new Error(`${label} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  url.hash = "";
  return url.toString();
}

export function assertNoUnsupportedDingTalkRobotFields(input: Record<string, unknown> = {}) {
  const customFields = Object.entries(CUSTOM_ROBOT_FIELDS)
    .filter(([field]) => hasValue(input[field]))
    .map(([, label]) => label);
  if (customFields.length) {
    throw new Error(
      `DingTalk custom robot webhook fields (${Array.from(new Set(customFields)).join(", ")}) ` +
      "cannot be used by the Enterprise Stream connector. Configure internal app appKey/appSecret, robotCode, and REST base URL instead.",
    );
  }
}

export function normalizeDingTalkBridgeCredentials(input: Record<string, unknown> = {}): DingTalkBridgeCredentials {
  assertNoUnsupportedDingTalkRobotFields(input);
  const appKey = cleanString(input.appKey ?? input.clientId);
  const appSecret = cleanString(input.appSecret ?? input.clientSecret);
  const robotCode = cleanString(input.robotCode);
  const missing = [];
  if (!appKey) missing.push("internal app appKey/clientId");
  if (!appSecret) missing.push("internal app appSecret/clientSecret");
  if (!robotCode) missing.push("enterprise robotCode");
  if (missing.length) {
    throw new Error(`DingTalk Enterprise Stream connector requires ${missing.join(", ")}`);
  }

  return {
    appKey,
    appSecret,
    robotCode,
    restBaseUrl: normalizeDingTalkBaseUrl(input.restBaseUrl || DINGTALK_REST_API_BASE_URL, "DingTalk REST base URL"),
    streamOpenUrl: normalizeDingTalkEndpointUrl(input.streamOpenUrl || DINGTALK_STREAM_OPEN_URL, "DingTalk Stream open endpoint"),
  };
}
