import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDeskRoute } from "../server/routes/desk.js";
import { parseDesignDocumentPreview } from "../shared/design-document-preview.ts";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(async ({ messages }) => {
    const joined = messages.map((message) => String(message.content || "")).join("\n");
    if (joined.includes("session secret")) throw new Error("session history leaked into mind map prompt");
    return JSON.stringify({
      title: "Project Plan",
      topics: [
        { title: "Goals", children: [{ title: "Reader" }, { title: "Channel" }] },
        { title: "Risks", children: [{ title: "Model isolation" }] },
      ],
    });
  }),
}));

describe("desk mind map creation", () => {
  const tempRoots = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  it("creates a parseable XMind file through the desk file route", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-mindmap-route-"));
    tempRoots.push(root);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const engine = {
      deskCwd: workspace,
      homeCwd: workspace,
      isApprovedDeskDir: (dir) => path.resolve(dir) === path.resolve(workspace),
      getAgent: () => ({ cronStore: null }),
    };
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request("/api/desk/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createMindmap",
        dir: workspace,
        name: "project-plan.xmind",
        title: "Project Plan",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.files.map((file) => file.name)).toContain("project-plan.xmind");

    const preview = await parseDesignDocumentPreview(path.join(workspace, "project-plan.xmind"));
    expect(preview).toMatchObject({
      kind: "mindmap",
      format: "XMind",
      canRenderNatively: true,
    });
    expect(preview.sections[0].items).toEqual(["Project Plan"]);
  });

  it("creates a structured XMind file from a document without reading session history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-doc-mindmap-route-"));
    tempRoots.push(root);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "brief.md"), [
      "# Project Plan",
      "## Goals",
      "- Reader",
      "- Channel",
      "## Risks",
      "- Model isolation",
    ].join("\n"));

    const engine = {
      deskCwd: workspace,
      homeCwd: workspace,
      currentAgentId: "agent-a",
      isApprovedDeskDir: (dir) => path.resolve(dir) === path.resolve(workspace),
      getAgent: () => ({ id: "agent-a", cronStore: null }),
      resolveUtilityConfig: () => ({
        utility_large: { id: "utility-large", provider: "mock", api: "openai" },
        large_api_key: "test-key",
        large_base_url: "https://llm.test",
        large_api: "openai",
      }),
      getSessionByPath: () => ({ messages: [{ role: "user", content: "session secret" }] }),
    };
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request("/api/desk/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createMindmapFromDocument",
        dir: workspace,
        sourceName: "brief.md",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.files.map((file) => file.name)).toContain("brief.xmind");

    const preview = await parseDesignDocumentPreview(path.join(workspace, "brief.xmind"));
    expect(preview.sections[0].items).toEqual([
      "Project Plan",
      "  Goals",
      "    Reader",
      "    Channel",
      "  Risks",
      "    Model isolation",
    ]);
  });

  it("keeps adjacent document bullets as sibling mind map topics when LLM is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-doc-mindmap-fallback-"));
    tempRoots.push(root);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes.md"), [
      "# Release Plan",
      "## Reader",
      "- XMind preview",
      "- Document conversion",
    ].join("\n"));

    const engine = {
      deskCwd: workspace,
      homeCwd: workspace,
      isApprovedDeskDir: (dir) => path.resolve(dir) === path.resolve(workspace),
      getAgent: () => ({ cronStore: null }),
      resolveUtilityConfig: () => { throw new Error("no model configured"); },
    };
    const app = new Hono();
    app.route("/api", createDeskRoute(engine, { scheduler: {} }));

    const res = await app.request("/api/desk/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createMindmapFromDocument",
        dir: workspace,
        sourceName: "notes.md",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const preview = await parseDesignDocumentPreview(path.join(workspace, "notes.xmind"));
    expect(preview.sections[0].items).toEqual([
      "notes",
      "  Release Plan",
      "    Reader",
      "      XMind preview",
      "      Document conversion",
    ]);
  });
});
