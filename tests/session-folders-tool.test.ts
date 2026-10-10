import { describe, expect, it, vi } from "vitest";
import { createSessionFoldersTool } from "../lib/tools/session-folders-tool.js";

function textPayload(result) {
  return JSON.parse(result.content[0].text);
}

function makeCtx(sessionPath = "/tmp/agents/codia/sessions/s1.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

describe("session_folders tool", () => {
  it("lists the current session folder scope", async () => {
    const sessionPath = "/tmp/agents/codia/sessions/s1.jsonl";
    const engine = {
      getSessionFolderScope: vi.fn(() => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      })),
    };
    const tool = createSessionFoldersTool({ getEngine: () => engine });

    const result = await tool.execute("call-1", { action: "list" }, null, null, makeCtx(sessionPath));

    expect(textPayload(result)).toEqual({
      session_folders: {
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: ["/workspace/reference"],
        authorizedFolders: ["/external/assets"],
        sandboxFolders: ["/workspace/project", "/workspace/reference", "/external/assets"],
      },
    });
  });

  it("requires confirmation before adding an authorized folder", async () => {
    const sessionPath = "/tmp/agents/codia/sessions/s1.jsonl";
    const folder = "/external/assets";
    const engine = {
      addSessionAuthorizedFolder: vi.fn(async () => ({
        sessionPath,
        cwd: "/workspace/project",
        workspaceFolders: [],
        authorizedFolders: [folder],
        sandboxFolders: ["/workspace/project", folder],
      })),
      getSessionFolderScope: vi.fn(),
    };
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-folder-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const emitEvent = vi.fn();
    const tool = createSessionFoldersTool({
      getEngine: () => engine,
      getConfirmStore: () => confirmStore,
      emitEvent,
    });

    const result = await tool.execute("call-1", { action: "add", folder }, null, null, makeCtx(sessionPath));

    expect(confirmStore.create).toHaveBeenCalledWith("session_folders", { action: "add", folder }, sessionPath);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session_confirmation",
      request: expect.objectContaining({
        confirmId: "confirm-folder-1",
        kind: "session_folders",
      }),
    }), sessionPath);
    expect(engine.addSessionAuthorizedFolder).toHaveBeenCalledWith(sessionPath, folder);
    expect(result.details).toMatchObject({ action: "add", confirmed: true, sessionPath, folder });
    expect(textPayload(result).session_folders.authorizedFolders).toEqual([folder]);
  });
});
