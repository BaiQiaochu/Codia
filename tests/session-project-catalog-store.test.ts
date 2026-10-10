import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { SessionProjectCatalogStore } from "../core/session-project-catalog-store.js";

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-projects-"));
  const userDir = path.join(root, "user");
  return {
    root,
    userDir,
    store: new SessionProjectCatalogStore({ userDir }),
  };
}

describe("SessionProjectCatalogStore", () => {
  it("creates a project catalog file only when the user creates organization data", () => {
    const { userDir, store } = makeStore();

    expect(store.getCatalog()).toEqual({ folders: [], projects: [] });
    expect(fs.existsSync(path.join(userDir, "session-projects.json"))).toBe(false);

    const project = store.createProject({ name: "Briefs and drafts" });

    expect(project.folderId).toBe(null);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, "session-projects.json"), "utf-8"))).toEqual({
      version: 1,
      folders: [],
      projects: [project],
    });
  });

  it("renames projects without changing session ownership", () => {
    const { store } = makeStore();

    const project = store.createProject({ name: "OH-Plugins" });

    expect(store.updateProject(project.id, { name: "OH Plugins" })).toMatchObject({
      id: project.id,
      name: "OH Plugins",
    });
  });

  it("persists project ordering in a single project level", () => {
    const { store } = makeStore();

    const projectA = store.createProject({ name: "A1" });
    const projectB = store.createProject({ name: "A2" });
    const projectC = store.createProject({ name: "Root" });
    const reordered = store.reorderProjects({ folderId: null, projectIds: [projectB.id, projectA.id] });

    expect(reordered.projects.map(project => project.id)).toEqual([
      projectB.id,
      projectA.id,
      projectC.id,
    ]);
  });

  it("creates folders and moves projects into a folder with scoped ordering", () => {
    const { store } = makeStore();

    const folder = store.createFolder({ name: "Drafts" });
    const projectA = store.createProject({ name: "Briefs" });
    const projectB = store.createProject({ name: "缃戠珯", folderId: folder.id });

    expect(folder).toMatchObject({ id: expect.stringMatching(/^folder-/), name: "Drafts", order: 0 });
    expect(projectB.folderId).toBe(folder.id);

    const moved = store.updateProject(projectA.id, { folderId: folder.id });
    expect(moved).toMatchObject({ id: projectA.id, folderId: folder.id, order: 1 });

    const reordered = store.reorderProjects({ folderId: folder.id, projectIds: [projectA.id, projectB.id] });
    expect(reordered.projects.filter(project => project.folderId === folder.id).map(project => project.id)).toEqual([
      projectA.id,
      projectB.id,
    ]);
  });

  it("persists folder ordering independently from project ordering", () => {
    const { store } = makeStore();

    const folderA = store.createFolder({ name: "A" });
    const folderB = store.createFolder({ name: "B" });
    const reordered = store.reorderFolders({ folderIds: [folderB.id, folderA.id] });

    expect(reordered.folders.map(folder => folder.id)).toEqual([folderB.id, folderA.id]);
  });

  it("deletes projects from the catalog without deleting folders", () => {
    const { store } = makeStore();

    const folder = store.createFolder({ name: "Work" });
    const projectA = store.createProject({ name: "A", folderId: folder.id });
    const projectB = store.createProject({ name: "B", folderId: folder.id });

    const catalog = store.deleteProject(projectA.id);

    expect(catalog.folders.map(item => item.id)).toEqual([folder.id]);
    expect(catalog.projects.map(item => item.id)).toEqual([projectB.id]);
    expect(store.getCatalog().projects.map(item => item.id)).toEqual([projectB.id]);
  });

  it("deletes folders by moving child projects back to the root level in order", () => {
    const { store } = makeStore();

    const root = store.createProject({ name: "Root" });
    const folder = store.createFolder({ name: "Work" });
    const projectA = store.createProject({ name: "A", folderId: folder.id });
    const projectB = store.createProject({ name: "B", folderId: folder.id });

    const catalog = store.deleteFolder(folder.id);

    expect(catalog.folders).toEqual([]);
    expect(catalog.projects.map(project => ({
      id: project.id,
      folderId: project.folderId,
      order: project.order,
    }))).toEqual([
      { id: root.id, folderId: null, order: 0 },
      { id: projectA.id, folderId: null, order: 1 },
      { id: projectB.id, folderId: null, order: 2 },
    ]);
  });

  it("rejects blank names and missing folder moves instead of silently falling back", () => {
    const { store } = makeStore();

    const project = store.createProject({ name: "Good" });
    expect(() => store.createProject({ name: " " })).toThrow(/name/);
    expect(() => store.createFolder({ name: " " })).toThrow(/name/);
    expect(() => store.createProject({ name: "Bad", folderId: "missing-folder" })).toThrow(/folder not found/);
    expect(() => store.updateProject(project.id, { folderId: "folder-work" })).toThrow(/folder not found/);
    expect(() => store.reorderProjects({ folderId: "folder-work", projectIds: [project.id] })).toThrow(/folder not found/);
    expect(() => store.deleteProject("missing-project")).toThrow(/project not found/);
    expect(() => store.deleteFolder("missing-folder")).toThrow(/folder not found/);
  });

  it("preserves catalog files that contain folders", () => {
    const { userDir, store } = makeStore();
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "session-projects.json"), JSON.stringify({
      version: 1,
      folders: [{ id: "folder-work", name: "Drafts", order: 0 }],
      projects: [{ id: "project-resume", name: "Briefs and drafts", folderId: "folder-work", order: 0 }],
    }));

    expect(store.getCatalog()).toEqual({
      folders: [{ id: "folder-work", name: "Drafts", order: 0 }],
      projects: [{ id: "project-resume", name: "Briefs and drafts", folderId: "folder-work", order: 0 }],
    });
  });

  it("materializes cwd-derived project metadata when an auto project is renamed or reordered", () => {
    const { store } = makeStore();
    const project = store.updateProject("cwd:%2Ftmp%2Fproject-codia", { name: "project-codia" });

    expect(project).toMatchObject({
      id: "cwd:%2Ftmp%2Fproject-codia",
      name: "project-codia",
      folderId: null,
      order: 0,
    });
    expect(store.getCatalog().projects).toEqual([project]);
    expect(store.reorderProjects({ folderId: null, projectIds: [project.id] }).projects[0].id).toBe(project.id);
  });
});
