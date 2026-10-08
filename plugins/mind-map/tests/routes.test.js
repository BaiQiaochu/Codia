import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { parseDesignDocumentPreview } from "../../../shared/design-document-preview.ts";
import { MindMapStore } from "../lib/mind-map-store.js";
import registerMindMapRoutes from "../routes/mind-map.js";

const tempDirs = [];

function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-mm-routes-"));
  tempDirs.push(dataDir);
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const store = new MindMapStore(dataDir);
  const app = new Hono();
  const ctx = {
    pluginId: "mind-map",
    dataDir,
    getWorkspaceDir: () => workspace,
    _mindMap: { store },
    bus: {
      request: async (type, payload) => {
        if (type !== "utility:call-text") throw new Error(`unexpected bus request: ${type}`);
        if (String(payload?.messages?.[0]?.content || "").includes("session secret")) {
          throw new Error("session history leaked into mind map prompt");
        }
        return {
          text: JSON.stringify({
            title: "Project Plan",
            topics: [
              { title: "Goals", children: [{ title: "Reader" }, { title: "Channel" }] },
              { title: "Risks", children: [{ title: "Model isolation" }] },
            ],
          }),
        };
      },
    },
  };
  registerMindMapRoutes(app, ctx);
  return { app, workspace };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("mind map plugin routes", () => {
  it("generates an XMind file from an explicit document path and serves its tree", async () => {
    const { app, workspace } = makeApp();
    const sourcePath = path.join(workspace, "brief.md");
    fs.writeFileSync(sourcePath, "# Project Plan\n## Goals\n- Reader\n- Channel\n");

    const generateRes = await app.request("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: sourcePath, outputDir: workspace }),
    });
    expect(generateRes.status).toBe(200);
    const generated = await generateRes.json();
    expect(generated).toMatchObject({ ok: true, fileName: "brief.xmind" });

    const treeRes = await app.request(`/tree?path=${encodeURIComponent(generated.filePath)}`);
    expect(treeRes.status).toBe(200);
    const tree = await treeRes.json();
    expect(tree.root.children.map((node) => node.title)).toEqual(["Goals", "Risks"]);

    const preview = await parseDesignDocumentPreview(generated.filePath);
    expect(preview.sections[0].items).toEqual([
      "Project Plan",
      "  Goals",
      "    Reader",
      "    Channel",
      "  Risks",
      "    Model isolation",
    ]);

    const previewRes = await app.request(`/preview?path=${encodeURIComponent(generated.filePath)}`);
    expect(previewRes.status).toBe(200);
    expect(await previewRes.json()).toMatchObject({
      ok: true,
      preview: {
        kind: "mindmap",
        format: "XMind",
        canRenderNatively: true,
      },
      tree: {
        title: "Project Plan",
      },
    });
  });

  it("uses the current workspace as the default generated file directory", async () => {
    const { app, workspace } = makeApp();
    const sourcePath = path.join(workspace, "current-doc.md");
    fs.writeFileSync(sourcePath, "# Current Workspace\n- Correct path\n");

    const generateRes = await app.request("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: sourcePath }),
    });

    expect(generateRes.status).toBe(200);
    const generated = await generateRes.json();
    expect(generated.filePath).toBe(path.join(workspace, "current-doc.xmind"));
    expect(fs.existsSync(path.join(workspace, "current-doc.xmind"))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(workspace), "current-doc.xmind"))).toBe(false);
  });

  it("serves the editor with an XMind-style canvas surface", async () => {
    const { app } = makeApp();

    const res = await app.request("/card?path=C%3A%2Fwork%2Fplan.xmind");
    const html = await res.text();

    expect(html).toContain("mind-map-canvas");
    expect(html).toContain("mind-map-branch");
    expect(html).toContain("mind-map-toolbar");
  });

  it("serves the editor with Chinese controls and theme-aware surfaces", async () => {
    const { app } = makeApp();

    const res = await app.request("/page?path=C%3A%2Fwork%2Fplan.xmind");
    const html = await res.text();

    expect(html).toContain('value="C:/work/plan.xmind"');

    for (const text of [
      "<title>思维导图</title>",
      'placeholder="XMind 文件路径"',
      ">加载<",
      ">保存<",
      ">重命名<",
      ">添加子节点<",
      ">删除<",
      "已选择节点",
      'placeholder="选择一个节点"',
      "载入或新建 XMind 文件后即可编辑思维导图。",
      "当前编辑器只使用你加载的文件路径，不读取其他会话。",
    ]) {
      expect(html).toContain(text);
    }

    for (const english of [
      ">Load<",
      ">Save<",
      ">Rename<",
      ">Add Child<",
      ">Delete<",
      "Selected node",
      "XMind file path",
      "Load or create an XMind file",
      "This editor only uses the file path",
    ]) {
      expect(html).not.toContain(english);
    }

    expect(html).toContain("--mm-bg:var(--bg");
    expect(html).toContain("--mm-panel:var(--bg-card");
    expect(html).toContain("--mm-text:var(--text");
    expect(html).toContain("--mm-accent:var(--accent");
    expect(html).toContain("--mm-radius-card:var(--radius-card");
    expect(html).toContain("--mm-hover:var(--overlay-subtle");
    expect(html).toContain("--mm-border:var(--overlay-light");
    expect(html).toContain("--mm-selected:var(--accent-light");
    expect(html).not.toContain("class=\"palette\"");
    expect(html).not.toContain(".palette");
    expect(html).not.toContain("mind-map-canvas:before");
    expect(html).not.toContain("--mm-branch-");
    expect(html).not.toContain("linear-gradient(135deg,#1f6feb,#35a7ff)");
    expect(html).not.toContain("radial-gradient(circle at");
    expect(html).not.toContain("#f59f00");
    expect(html).not.toContain("rgba(255,255,255,.92)");
  });

  it("edits nodes through the route API and persists the XMind file", async () => {
    const { app, workspace } = makeApp();
    const createRes = await app.request("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Manual Map", outputDir: workspace }),
    });
    const created = await createRes.json();

    const tree = await (await app.request(`/tree?path=${encodeURIComponent(created.filePath)}`)).json();
    const rootId = tree.root.id;

    const addRes = await app.request("/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: created.filePath, parentId: rootId, title: "First Topic" }),
    });
    expect(addRes.status).toBe(200);
    const added = await addRes.json();

    const renameRes = await app.request(`/nodes/${encodeURIComponent(added.node.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: created.filePath, title: "Renamed Topic" }),
    });
    expect(renameRes.status).toBe(200);

    const preview = await parseDesignDocumentPreview(created.filePath);
    expect(preview.sections[0].items).toEqual(["Manual Map", "  Renamed Topic"]);
  });
});
