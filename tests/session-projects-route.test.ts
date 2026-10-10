import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

function makeApp(engine) {
  const app = new Hono();
  app.route("/api", createSessionProjectsRoute(engine));
  return app;
}

import { createSessionProjectsRoute } from "../server/routes/session-projects.js";

describe("session projects route", () => {
  it("reads the user-level project catalog", async () => {
    const catalog = {
      folders: [],
      projects: [{ id: "project-resume", name: "Briefs and drafts", folderId: null, order: 0 }],
    };
    const engine = {
      getSessionProjectCatalog: vi.fn(() => catalog),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/session-projects");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ catalog });
    expect(engine.getSessionProjectCatalog).toHaveBeenCalledTimes(1);
  });

  it("creates projects through the engine facade", async () => {
    const engine = {
      createSessionProject: vi.fn(({ name, folderId }) => ({ id: "project-new", name, folderId, order: 3 })),
    };
    const app = makeApp(engine);

    const projectRes = await app.request("/api/session-projects/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "插件官网" }),
    });
    const projectBody = await projectRes.json();

    expect(projectRes.status).toBe(200);
    expect(projectBody.project).toEqual({ id: "project-new", name: "插件官网", folderId: null, order: 3 });
    expect(engine.createSessionProject).toHaveBeenCalledWith({ name: "插件官网", folderId: null });
  });

  it("creates and reorders folders through the engine facade", async () => {
    const engine = {
      createSessionProjectFolder: vi.fn(({ name }) => ({ id: "folder-new", name, order: 2 })),
      reorderSessionProjectFolders: vi.fn(({ folderIds }) => ({
        folders: folderIds.map((id, order) => ({ id, name: id, order })),
        projects: [],
      })),
    };
    const app = makeApp(engine);

    const createRes = await app.request("/api/session-projects/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Drafts" }),
    });
    const createBody = await createRes.json();

    const reorderRes = await app.request("/api/session-projects/folders/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderIds: ["folder-b", "folder-a"] }),
    });
    const reorderBody = await reorderRes.json();

    expect(createRes.status).toBe(200);
    expect(createBody.folder).toEqual({ id: "folder-new", name: "Drafts", order: 2 });
    expect(engine.createSessionProjectFolder).toHaveBeenCalledWith({ name: "Drafts" });
    expect(reorderRes.status).toBe(200);
    expect(reorderBody.catalog.folders.map(folder => folder.id)).toEqual(["folder-b", "folder-a"]);
    expect(engine.reorderSessionProjectFolders).toHaveBeenCalledWith({ folderIds: ["folder-b", "folder-a"] });
  });

  it("creates projects inside folders and moves projects across levels", async () => {
    const engine = {
      createSessionProject: vi.fn(({ name, folderId }) => ({ id: "project-new", name, folderId, order: 0 })),
      updateSessionProject: vi.fn((id, patch) => ({ id, name: "Moved", folderId: patch.folderId, order: 1 })),
      reorderSessionProjects: vi.fn(({ folderId, projectIds }) => ({
        folders: [{ id: "folder-work", name: "Drafts", order: 0 }],
        projects: projectIds.map((id, order) => ({ id, name: id, folderId, order })),
      })),
    };
    const app = makeApp(engine);

    const createRes = await app.request("/api/session-projects/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "官网", folderId: "folder-work" }),
    });
    const moveRes = await app.request("/api/session-projects/projects/project-new", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: null }),
    });
    const reorderRes = await app.request("/api/session-projects/projects/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: "folder-work", projectIds: ["project-a", "project-b"] }),
    });

    expect(createRes.status).toBe(200);
    expect(engine.createSessionProject).toHaveBeenCalledWith({ name: "官网", folderId: "folder-work" });
    expect(moveRes.status).toBe(200);
    expect(engine.updateSessionProject).toHaveBeenCalledWith("project-new", { folderId: null });
    expect(reorderRes.status).toBe(200);
    expect(engine.reorderSessionProjects).toHaveBeenCalledWith({
      folderId: "folder-work",
      projectIds: ["project-a", "project-b"],
    });
  });

  it("renames projects and persists same-level order", async () => {
    const engine = {
      updateSessionProject: vi.fn(() => ({ id: "project-codia", name: "Project codia", folderId: null, order: 0 })),
      reorderSessionProjects: vi.fn(() => ({
        folders: [],
        projects: [
          { id: "project-codia", name: "Project codia", folderId: null, order: 0 },
          { id: "project-plugins", name: "OH-Plugins", folderId: null, order: 1 },
        ],
      })),
    };
    const app = makeApp(engine);

    const renameRes = await app.request("/api/session-projects/projects/project-codia", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project codia" }),
    });
    const renameBody = await renameRes.json();

    const orderRes = await app.request("/api/session-projects/projects/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: null, projectIds: ["project-codia", "project-plugins"] }),
    });
    const orderBody = await orderRes.json();

    expect(renameRes.status).toBe(200);
    expect(renameBody.project.name).toBe("Project codia");
    expect(engine.updateSessionProject).toHaveBeenCalledWith("project-codia", { name: "Project codia" });
    expect(orderRes.status).toBe(200);
    expect(orderBody.catalog.projects.map((project) => project.id)).toEqual(["project-codia", "project-plugins"]);
    expect(engine.reorderSessionProjects).toHaveBeenCalledWith({
      folderId: null,
      projectIds: ["project-codia", "project-plugins"],
    });
  });

  it("renames folders through the engine facade", async () => {
    const engine = {
      updateSessionProjectFolder: vi.fn(() => ({ id: "folder-work", name: "Drafts", order: 0 })),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/session-projects/folders/folder-work", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Drafts" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: { id: "folder-work", name: "Drafts", order: 0 } });
    expect(engine.updateSessionProjectFolder).toHaveBeenCalledWith("folder-work", { name: "Drafts" });
  });

  it("deletes projects and folders through the engine facade", async () => {
    const engine = {
      deleteSessionProject: vi.fn(async (id) => ({
        catalog: { folders: [], projects: [] },
        assignment: { projectId: "cwd:", sessionPaths: ["/tmp/agents/codia/sessions/a.jsonl"] },
      })),
      deleteSessionProjectFolder: vi.fn((id) => ({
        folders: [],
        projects: [{ id: "project-a", name: "A", folderId: null, order: 0 }],
      })),
    };
    const app = makeApp(engine);

    const projectRes = await app.request("/api/session-projects/projects/project-root", {
      method: "DELETE",
    });
    const folderRes = await app.request("/api/session-projects/folders/folder-work", {
      method: "DELETE",
    });

    expect(projectRes.status).toBe(200);
    expect(await projectRes.json()).toEqual({
      ok: true,
      catalog: { folders: [], projects: [] },
      assignment: { projectId: "cwd:", sessionPaths: ["/tmp/agents/codia/sessions/a.jsonl"] },
    });
    expect(engine.deleteSessionProject).toHaveBeenCalledWith("project-root");
    expect(folderRes.status).toBe(200);
    expect(await folderRes.json()).toEqual({
      ok: true,
      catalog: {
        folders: [],
        projects: [{ id: "project-a", name: "A", folderId: null, order: 0 }],
      },
    });
    expect(engine.deleteSessionProjectFolder).toHaveBeenCalledWith("folder-work");
  });

  it("assigns a session to a project through session meta", async () => {
    const engine = {
      setSessionProjectAssignment: vi.fn(async ({ sessionPath, projectId }) => ({ sessionPath, projectId })),
    };
    const app = makeApp(engine);

    const res = await app.request("/api/session-projects/session-assignment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionPath: "/tmp/agents/codia/sessions/a.jsonl",
        projectId: "project-codia",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      assignment: {
        sessionPath: "/tmp/agents/codia/sessions/a.jsonl",
        projectId: "project-codia",
      },
    });
    expect(engine.setSessionProjectAssignment).toHaveBeenCalledWith({
      sessionPath: "/tmp/agents/codia/sessions/a.jsonl",
      projectId: "project-codia",
    });
  });
});
