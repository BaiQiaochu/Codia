import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileRefToPath, statFileRef } from "../lib/file-ref/resource-io.ts";

describe("ResourceIO v0", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeTree() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-resource-io-"));
    const sessionPath = path.join(tmpDir, "agents", "gsap", "sessions", "main.jsonl");
    const pluginFile = path.join(tmpDir, "plugin-data", "image-gen", "generated", "cover-source.png");
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    fs.writeFileSync(pluginFile, "image-bytes");
    return { sessionPath, pluginFile, workspace };
  }

  it("stats a SessionFile ref without exposing callers to sidecar paths", async () => {
    const { sessionPath, pluginFile } = makeTree();
    const resolveSessionFile = vi.fn(() => ({
      id: "sf_cover",
      fileId: "sf_cover",
      sessionPath,
      filePath: pluginFile,
      realPath: pluginFile,
      filename: "cover-source.png",
      label: "cover-source.png",
      mime: "image/png",
      kind: "image",
      size: 11,
      status: "available",
    }));

    const stat = await statFileRef(
      { type: "session_file", fileId: "sf_cover", sessionPath },
      { resolveSessionFile },
    );

    expect(resolveSessionFile).toHaveBeenCalledWith("sf_cover", { sessionPath });
    expect(stat).toMatchObject({
      type: "session_file",
      fileId: "sf_cover",
      filename: "cover-source.png",
      mime: "image/png",
      kind: "image",
      size: 11,
      isDirectory: false,
    });
  });

  it("copies a SessionFile into an allowed local workspace and registers the copy as external", async () => {
    const { sessionPath, pluginFile, workspace } = makeTree();
    const resolveSessionFile = vi.fn(() => ({
      id: "sf_cover",
      fileId: "sf_cover",
      sessionPath,
      filePath: pluginFile,
      realPath: pluginFile,
      filename: "cover-source.png",
      label: "cover-source.png",
      status: "available",
    }));
    const registerSessionFile = vi.fn(({ filePath, label, origin, operation, storageKind }) => ({
      id: "sf_copied",
      fileId: "sf_copied",
      sessionPath,
      filePath,
      label,
      origin,
      operation,
      storageKind,
    }));

    const result = await copyFileRefToPath({
      from: { type: "session_file", fileId: "sf_cover", sessionPath },
      targetDir: "assets",
      filename: "cover.png",
      cwd: workspace,
      allowedRoots: [workspace],
      sessionPath,
      resolveSessionFile,
      registerSessionFile,
    });

    const targetPath = path.join(workspace, "assets", "cover.png");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("image-bytes");
    expect(registerSessionFile).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath,
      filePath: targetPath,
      label: "cover.png",
      origin: "session_file_copy",
      operation: "copied",
      storageKind: "external",
    }));
    expect(result).toMatchObject({
      filePath: targetPath,
      sessionFile: { fileId: "sf_copied", storageKind: "external" },
    });
  });

  it("refuses to copy outside allowed roots", async () => {
    const { sessionPath, pluginFile, workspace } = makeTree();
    const outside = path.join(tmpDir!, "outside");
    fs.mkdirSync(outside, { recursive: true });
    const resolveSessionFile = vi.fn(() => ({
      id: "sf_cover",
      sessionPath,
      filePath: pluginFile,
      realPath: pluginFile,
      status: "available",
    }));

    await expect(copyFileRefToPath({
      from: { type: "session_file", fileId: "sf_cover", sessionPath },
      targetDir: outside,
      filename: "cover.png",
      cwd: workspace,
      allowedRoots: [workspace],
      sessionPath,
      resolveSessionFile,
    })).rejects.toThrow(/outside allowed roots/i);
  });

  it("refuses local path sources outside source allowed roots", async () => {
    const { pluginFile, workspace } = makeTree();

    await expect(copyFileRefToPath({
      from: { type: "path", path: pluginFile },
      targetDir: "assets",
      filename: "cover.png",
      cwd: workspace,
      allowedRoots: [workspace],
      sourceAllowedRoots: [workspace],
    })).rejects.toThrow(/copy source is outside allowed roots/i);
  });
});
