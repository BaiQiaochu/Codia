import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsRoute } from "../server/routes/fs.js";

let tempRoot;
let codiaHome;
let workspace;
let app;

function makeApp() {
  const engine = {
    codiaHome,
    defaultDeskCwd: workspace,
    homeCwd: workspace,
    deskCwd: workspace,
    config: { cwd_history: [] },
    currentSessionPath: null,
    getSessionWorkspaceFolders: () => [],
  };
  const hono = new Hono();
  hono.route("/api", createFsRoute(engine));
  return hono;
}

function fsUrl(route, filePath, key = "path") {
  return `/api${route}?${key}=${encodeURIComponent(filePath)}`;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codia-fs-route-"));
  codiaHome = path.join(tempRoot, "home");
  workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(codiaHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  app = makeApp();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("fs route", () => {
  it("writes text only when the file version is unchanged", async () => {
    const filePath = path.join(workspace, "note.md");
    fs.writeFileSync(filePath, "alpha", "utf-8");

    const snapshotRes = await app.request(fsUrl("/fs/read-snapshot", filePath));
    expect(snapshotRes.status).toBe(200);
    const snapshot = await snapshotRes.json();
    expect(snapshot.content).toBe("alpha");
    expect(snapshot.version.sha256).toMatch(/^[a-f0-9]{64}$/);

    const writeRes = await app.request("/api/fs/write-if-unchanged", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "beta", expectedVersion: snapshot.version }),
    });
    expect(writeRes.status).toBe(200);
    expect(await writeRes.json()).toMatchObject({ ok: true, conflict: false });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("beta");

    const conflictRes = await app.request("/api/fs/write-if-unchanged", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "gamma", expectedVersion: snapshot.version }),
    });
    expect(conflictRes.status).toBe(200);
    expect(await conflictRes.json()).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("beta");
  });

  it("rejects deletes outside approved roots", async () => {
    const outsidePath = path.join(tempRoot, "outside.txt");
    fs.writeFileSync(outsidePath, "outside", "utf-8");

    const res = await app.request("/api/fs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outsidePath }),
    });

    expect(res.status).toBe(403);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });

  it("lists and reads skill preview files inside an approved workspace", async () => {
    const skillDir = path.join(workspace, ".agents", "skills", "demo");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo\n---\n# Demo", "utf-8");
    fs.writeFileSync(path.join(skillDir, "scripts", "run.js"), "console.log('demo');", "utf-8");

    const listRes = await app.request(fsUrl("/fs/list-skill-files", skillDir, "baseDir"));
    expect(listRes.status).toBe(200);
    const data = await listRes.json();
    expect(data.files[0].name).toBe("SKILL.md");
    expect(data.files.some((item) => item.name === "scripts" && item.isDir)).toBe(true);

    const readRes = await app.request(fsUrl("/fs/read-skill-file", path.join(skillDir, "SKILL.md")));
    expect(readRes.status).toBe(200);
    expect(await readRes.text()).toContain("# Demo");
  });

  it("converts approved xlsx files to html", async () => {
    const src = path.join(process.cwd(), "tests", "fixtures", "sample.xlsx");
    const filePath = path.join(workspace, "sample.xlsx");
    fs.copyFileSync(src, filePath);

    const res = await app.request(fsUrl("/fs/xlsx-html", filePath));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<table");
    expect(html).toContain("Alice");
  });

  it("returns design document previews for approved CAD files", async () => {
    const filePath = path.join(workspace, "part.obj");
    fs.writeFileSync(filePath, [
      "o Bracket",
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
      "usemtl Steel",
    ].join("\n"));

    const res = await app.request(fsUrl("/fs/design-preview", filePath));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      kind: "three-d",
      format: "Wavefront OBJ",
      canRenderNatively: true,
    });
    expect(data.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Geometry", items: expect.arrayContaining(["Vertices: 3", "Faces: 1"]) }),
      expect.objectContaining({ title: "Objects", items: ["Bracket"] }),
    ]));
  });

  it("rejects design document previews outside approved roots", async () => {
    const outsidePath = path.join(tempRoot, "outside.dxf");
    fs.writeFileSync(outsidePath, "0\nEOF\n", "utf-8");

    const res = await app.request(fsUrl("/fs/design-preview", outsidePath));

    expect(res.status).toBe(403);
  });
});
