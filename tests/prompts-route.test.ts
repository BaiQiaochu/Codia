import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createPromptsRoute,
  normalizeOptimizedPromptReply,
} from "../server/routes/prompts.ts";

function makeApp(engine: any) {
  const app = new Hono();
  app.route("/api", createPromptsRoute(engine));
  return app;
}

describe("prompts route", () => {
  it("rejects empty prompt optimization requests", async () => {
    const executeIsolated = vi.fn();
    const app = makeApp({ executeIsolated });

    const res = await app.request("/api/prompts/optimize", {
      method: "POST",
      body: JSON.stringify({ prompt: "   " }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(executeIsolated).not.toHaveBeenCalled();
  });

  it("runs prompt optimization in an isolated tool-free model call", async () => {
    const executeIsolated = vi.fn().mockResolvedValue({
      replyText: "```text\n优化后的提示词：清晰描述一只橘猫坐在雨夜拉面店门口。\n```",
      error: null,
    });
    const app = makeApp({
      currentAgentId: "default-agent",
      agentIdFromSessionPath: vi.fn(() => "session-agent"),
      executeIsolated,
    });

    const res = await app.request("/api/prompts/optimize", {
      method: "POST",
      body: JSON.stringify({
        prompt: "画猫",
        sessionPath: "C:/tmp/session.jsonl",
        locale: "zh",
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.optimizedPrompt).toBe("清晰描述一只橘猫坐在雨夜拉面店门口。");
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated.mock.calls[0][0]).toContain("画猫");
    expect(executeIsolated.mock.calls[0][0]).toContain("只输出优化后的提示词");
    expect(executeIsolated.mock.calls[0][1]).toMatchObject({
      agentId: "session-agent",
      parentSessionPath: "C:/tmp/session.jsonl",
      toolFilter: [],
      builtinFilter: [],
      withMemory: false,
      permissionMode: "read_only",
    });
  });

  it("surfaces isolated execution failures", async () => {
    const app = makeApp({
      currentAgentId: "default-agent",
      executeIsolated: vi.fn().mockResolvedValue({ replyText: "", error: "model unavailable" }),
    });

    const res = await app.request("/api/prompts/optimize", {
      method: "POST",
      body: JSON.stringify({ prompt: "summarize this" }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain("model unavailable");
  });

  it("normalizes common model wrappers from optimized prompt replies", () => {
    expect(normalizeOptimizedPromptReply("优化后的提示词：\n```markdown\nA better prompt\n```", "raw"))
      .toBe("A better prompt");
    expect(normalizeOptimizedPromptReply("", "raw")).toBe("raw");
  });

  it("rejects empty research requests", async () => {
    const executeIsolated = vi.fn();
    const app = makeApp({ executeIsolated });

    const res = await app.request("/api/prompts/research", {
      method: "POST",
      body: JSON.stringify({ topic: "   " }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(executeIsolated).not.toHaveBeenCalled();
  });

  it("runs research mode with web search and fetch tools only", async () => {
    const executeIsolated = vi.fn().mockResolvedValue({
      replyText: "research report with citations",
      error: null,
      sessionPath: "C:/tmp/research-session.jsonl",
    });
    const agentIdFromSessionPath = vi.fn(() => "session-agent");
    const app = makeApp({
      currentAgentId: "default-agent",
      agentIdFromSessionPath,
      executeIsolated,
    });

    const res = await app.request("/api/prompts/research", {
      method: "POST",
      body: JSON.stringify({
        topic: "mainland china ai search product comparison",
        mode: "academic",
        sessionPath: "C:/tmp/session.jsonl",
        exportFormats: ["docx", "pdf", "exe"],
        locale: "zh",
      }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      topic: "mainland china ai search product comparison",
      mode: "academic",
      report: "research report with citations",
      exportFormats: ["word", "pdf"],
      sessionPath: "C:/tmp/research-session.jsonl",
    });
    expect(data.generatedAt).toEqual(expect.any(String));
    expect(data.searchPlan).toMatchObject({
      maxSearchResults: 16,
      minSources: 8,
    });
    expect(executeIsolated).toHaveBeenCalledTimes(1);
    expect(executeIsolated.mock.calls[0][0]).toContain("mainland china ai search product comparison");
    expect(executeIsolated.mock.calls[0][0]).toContain("web_search");
    expect(executeIsolated.mock.calls[0][0]).toContain("web_fetch");
    expect(executeIsolated.mock.calls[0][0]).toContain("citations");
    expect(executeIsolated.mock.calls[0][1]).toMatchObject({
      agentId: "session-agent",
      parentSessionPath: "C:/tmp/session.jsonl",
      toolFilter: ["web_search", "web_fetch"],
      builtinFilter: [],
      withMemory: false,
      permissionMode: "read_only",
      operation: "research_mode",
    });
  });

  it("surfaces research execution failures", async () => {
    const app = makeApp({
      currentAgentId: "default-agent",
      executeIsolated: vi.fn().mockResolvedValue({ replyText: "", error: "search unavailable" }),
    });

    const res = await app.request("/api/prompts/research", {
      method: "POST",
      body: JSON.stringify({ topic: "ai search", mode: "quick" }),
      headers: { "content-type": "application/json" },
    });
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain("search unavailable");
  });
});
