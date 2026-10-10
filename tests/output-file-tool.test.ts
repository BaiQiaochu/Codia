import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStageFilesTool } from "../lib/tools/output-file-tool.js";
import { loadLocale } from "../server/i18n.js";

describe("stage_files tool", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("describes the tool as the unified file delivery handoff", () => {
    loadLocale("en");
    const tool = createStageFilesTool({});

    expect(tool.description).toContain("hand one or more files to the user");
    expect(tool.description).toContain("Prefer fileIds");
    expect(tool.description).toContain("Use local absolute filepaths only");
    expect(tool.description).toContain("Bridge/remote platforms");
    expect(tool.description).toContain("consumers choose the platform-specific delivery");
    expect(tool.parameters.properties.fileIds.description).toContain("SessionFile ids");
    expect(tool.parameters.properties.filepaths.description).toContain("when no SessionFile id is available");
  });

  it("registers staged files as session files while preserving legacy mediaUrls", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-stage-tool-"));
    const filePath = path.join(tmpDir, "out.txt");
    fs.writeFileSync(filePath, "ok");
    const sessionPath = "/sessions/s1.jsonl";
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin }) => ({
      id: "sf_test1234567890",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
      origin,
      createdAt: 1,
    }));
    const tool = createStageFilesTool({ registerSessionFile });

    const result = await tool.execute("call-1", { filepaths: [filePath] }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath,
      label: "out.txt",
      origin: "stage_files",
    });
    expect(result.details.files).toEqual([expect.objectContaining({
      id: "sf_test1234567890",
      fileId: "sf_test1234567890",
      filePath,
      label: "out.txt",
      ext: "txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.items).toEqual([expect.objectContaining({
      type: "session_file",
      fileId: "sf_test1234567890",
      sessionPath,
      filePath,
      filename: "out.txt",
      mime: "text/plain",
      size: 2,
      kind: "document",
    })]);
    expect(result.details.media.mediaUrls).toEqual([filePath]);
  });

  it("delivers existing SessionFiles by fileId through the stage_files handoff", async () => {
    loadLocale("en");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-stage-fileid-"));
    const sessionPath = "/sessions/s1.jsonl";
    const coverPath = path.join(tmpDir, "cover.png");
    const altPath = path.join(tmpDir, "alt.png");
    fs.writeFileSync(coverPath, "cover");
    fs.writeFileSync(altPath, "alt");
    const existingById = {
      sf_existing123456: {
        id: "sf_existing123456",
        fileId: "sf_existing123456",
        sessionPath,
        filePath: coverPath,
        realPath: coverPath,
        displayName: "cover.png",
        filename: "cover.png",
        label: "cover.png",
        ext: "png",
        mime: "image/png",
        size: 5,
        kind: "image",
        origin: "session_file_copy",
        storageKind: "external",
        status: "available",
      },
      sf_existing789012: {
        id: "sf_existing789012",
        fileId: "sf_existing789012",
        sessionPath,
        filePath: altPath,
        realPath: altPath,
        displayName: "alt.png",
        filename: "alt.png",
        label: "alt.png",
        ext: "png",
        mime: "image/png",
        size: 3,
        kind: "image",
        origin: "session_file_copy",
        storageKind: "external",
        status: "available",
      },
    };
    const registerSessionFile = vi.fn(({ filePath, origin }) => {
      const existing = Object.values(existingById).find((file) => file.filePath === filePath);
      return { ...existing, origin, operations: ["copied", "staged"] };
    });
    const resolveSessionFile = vi.fn((fileId) => existingById[fileId]);
    const tool = createStageFilesTool({ registerSessionFile, resolveSessionFile });

    const result = await tool.execute("call-1", { fileIds: ["sf_existing123456", "sf_existing789012"] }, null, null, {
      sessionManager: { getSessionFile: () => sessionPath },
    });

    expect(resolveSessionFile).toHaveBeenCalledWith("sf_existing123456", { sessionPath });
    expect(resolveSessionFile).toHaveBeenCalledWith("sf_existing789012", { sessionPath });
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: coverPath,
      label: "cover.png",
      origin: "stage_files",
    });
    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: altPath,
      label: "alt.png",
      origin: "stage_files",
    });
    expect(result.details.files).toEqual([
      expect.objectContaining({
        id: "sf_existing123456",
        fileId: "sf_existing123456",
        filePath: coverPath,
        realPath: coverPath,
        label: "cover.png",
        displayName: "cover.png",
        filename: "cover.png",
        mime: "image/png",
        kind: "image",
        origin: "stage_files",
        storageKind: "external",
        status: "available",
      }),
      expect.objectContaining({
        id: "sf_existing789012",
        fileId: "sf_existing789012",
        filePath: altPath,
        realPath: altPath,
        label: "alt.png",
        displayName: "alt.png",
        filename: "alt.png",
        mime: "image/png",
        kind: "image",
        origin: "stage_files",
        storageKind: "external",
        status: "available",
      }),
    ]);
    expect(result.details.media.items).toEqual([
      expect.objectContaining({
        type: "session_file",
        fileId: "sf_existing123456",
        sessionPath,
        filePath: coverPath,
        filename: "cover.png",
        mime: "image/png",
        size: 5,
        kind: "image",
      }),
      expect.objectContaining({
        type: "session_file",
        fileId: "sf_existing789012",
        sessionPath,
        filePath: altPath,
        filename: "alt.png",
        mime: "image/png",
        size: 3,
        kind: "image",
      }),
    ]);
    expect(result.details.media.mediaUrls).toEqual([coverPath, altPath]);
  });
});
