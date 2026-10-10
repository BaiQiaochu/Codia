import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import YAML from "js-yaml";
import { ensureFirstRun } from "../core/first-run.ts";

export const E2E_PROVIDER = "e2e";
export const E2E_TEXT_MODEL = "e2e-text";
export const E2E_VISION_MODEL = "e2e-vision";

export async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(port || 0));
    });
  });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function writeYaml(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    YAML.dump(data, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
    "utf-8",
  );
}

function patchDefaultAgentConfig(homeDir) {
  const configPath = path.join(homeDir, "agents", "codia", "config.yaml");
  const raw = fs.existsSync(configPath)
    ? YAML.load(fs.readFileSync(configPath, "utf-8")) || {}
    : {};
  const textRef = { id: E2E_TEXT_MODEL, provider: E2E_PROVIDER };

  raw.agent = { ...(raw.agent || {}), name: raw.agent?.name || "Codia", yuan: raw.agent?.yuan || "codia" };
  raw.user = { ...(raw.user || {}), name: raw.user?.name || "" };
  raw.api = { ...(raw.api || {}), provider: E2E_PROVIDER };
  raw.models = {
    ...(raw.models || {}),
    chat: textRef,
    summarizer: textRef,
    compiler: textRef,
    utility: textRef,
  };
  raw.desk = {
    ...(raw.desk || {}),
    home_folder: path.join(homeDir, 'workspace'),
    heartbeat_enabled: false,
  };
  raw.channels = { ...(raw.channels || {}), enabled: false };
  fs.mkdirSync(raw.desk.home_folder, { recursive: true });

  writeYaml(configPath, raw);
}

function writeProfessionalE2EEditionMarker(homeDir) {
  writeJson(path.join(homeDir, ".ephemeral", "professional-edition.json"), {
    edition: "professional",
    licenseRequired: false,
    features: ["full"],
  });
}

export function createIsolatedE2EHome({ mockBaseUrl }) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-e2e-home-"));
  ensureFirstRun(homeDir, path.join(process.cwd(), "lib"), { defaultWorkspaceHome: homeDir });

  writeJson(path.join(homeDir, "user", "preferences.json"), {
    primaryAgent: "codia",
    setupComplete: true,
    locale: "zh-CN",
    sandbox: false,
    heartbeat_master: false,
  });

  writeYaml(path.join(homeDir, "added-models.yaml"), {
    providers: {
      [E2E_PROVIDER]: {
        display_name: "E2E Mock",
        base_url: mockBaseUrl,
        api: "openai-completions",
        api_key: "local",
        models: [
          {
            id: E2E_TEXT_MODEL,
            name: "E2E Text",
            context: 128000,
            maxOutput: 4096,
            image: false,
            reasoning: false,
          },
          {
            id: E2E_VISION_MODEL,
            name: "E2E Vision",
            context: 128000,
            maxOutput: 4096,
            image: true,
            reasoning: false,
          },
        ],
      },
    },
  });

  patchDefaultAgentConfig(homeDir);
  writeProfessionalE2EEditionMarker(homeDir);
  return homeDir;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

export async function startMockOpenAI({ reply = "E2E mock vision reply.", models = [], responseFactory } = {}) {
  const requests = [];
  const sockets = new Set();
  const modelList = [
    { id: E2E_TEXT_MODEL, object: "model", owned_by: E2E_PROVIDER },
    { id: E2E_VISION_MODEL, object: "model", owned_by: E2E_PROVIDER },
    ...models.map((model) => (
      typeof model === "string"
        ? { id: model, object: "model", owned_by: E2E_PROVIDER }
        : { object: "model", owned_by: E2E_PROVIDER, ...model }
    )),
  ];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: modelList,
        }));
        return;
      }

      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }

      const body = await readRequestBody(req);
      requests.push(body);
      const model = body.model || E2E_TEXT_MODEL;
      const responsePlan = typeof responseFactory === "function"
        ? await responseFactory({ body, requestIndex: requests.length - 1 })
        : null;
      const responseText = typeof responsePlan?.reply === "string" ? responsePlan.reply : reply;

      if (body.stream) {
        const id = `chatcmpl-e2e-${Date.now()}`;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(createChunk(id, model, { role: "assistant" }))}\n\n`);
        if (responsePlan?.toolCall) {
          const toolCall = responsePlan.toolCall;
          res.write(`data: ${JSON.stringify(createChunk(id, model, {
            tool_calls: [{
              index: 0,
              id: toolCall.id || `call_e2e_${Date.now()}`,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments || {}),
              },
            }],
          }))}\n\n`);
          res.write(`data: ${JSON.stringify(createChunk(id, model, {}, "tool_calls"))}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(createChunk(id, model, { content: responseText }))}\n\n`);
          res.write(`data: ${JSON.stringify(createChunk(id, model, {}, "stop"))}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-e2e-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          responsePlan?.toolCall
            ? {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: responsePlan.toolCall.id || `call_e2e_${Date.now()}`,
                    type: "function",
                    function: {
                      name: responsePlan.toolCall.name,
                      arguments: JSON.stringify(responsePlan.toolCall.arguments || {}),
                    },
                  }],
                },
                finish_reason: "tool_calls",
              }
            : { index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message || String(error) } }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function removeE2EHome(homeDir) {
  if (!homeDir) return;
  try {
    fs.rmSync(homeDir, { recursive: true, force: true });
  } catch {}
}
