// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitDesktopSessionMessage } from "../core/desktop-session-submit.js";

describe("submitDesktopSessionMessage", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeSessionPath() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-long-context-"));
    const sessionPath = path.join(tmpDir, "agents", "codia", "sessions", "main.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "{}\n");
    return sessionPath;
  }

  it("queues concurrent submissions for the same session before streaming status is emitted", async () => {
    let releaseFirstPrompt;
    const firstPrompt = new Promise((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn((sessionPath, text) => (
        text === "first" ? firstPrompt : Promise.resolve()
      )),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    const first = submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "first",
    });
    await vi.waitFor(() => expect(engine.promptSession).toHaveBeenCalledTimes(1));

    const second = submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "second",
    });

    expect(engine.promptSession).toHaveBeenCalledTimes(1);
    releaseFirstPrompt();
    await expect(first).resolves.toMatchObject({ text: null, toolMedia: [] });
    await expect(second).resolves.toMatchObject({ text: null, toolMedia: [] });
    expect(engine.promptSession).toHaveBeenNthCalledWith(2, "/tmp/session.jsonl", "second", { onExecutionStarted: expect.any(Function) });
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_status", isStreaming: true }),
      "/tmp/session.jsonl",
    );
  });

  it("passes video attachments and markers through to the active session", async () => {
    const promptSession = vi.fn(async () => {});
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "watch this",
      videos: [{ type: "video", data: "AAAA", mimeType: "video/mp4" }],
      videoAttachmentPaths: ["/tmp/demo.mp4"],
    });

    expect(promptSession).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "[attached_video: /tmp/demo.mp4]\nwatch this",
      {
        onExecutionStarted: expect.any(Function),
        videos: [{ type: "video", data: "AAAA", mimeType: "video/mp4" }],
        videoAttachmentPaths: ["/tmp/demo.mp4"],
      },
    );
  });

  it("passes audio attachments and markers through to the active session", async () => {
    const promptSession = vi.fn(async () => {});
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "listen to this",
      audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
      audioAttachmentPaths: ["/tmp/demo.wav"],
    });

    expect(promptSession).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "[attached_audio: /tmp/demo.wav]\nlisten to this",
      {
        onExecutionStarted: expect.any(Function),
        audios: [{ type: "audio", data: "BASE64", mimeType: "audio/wav" }],
        audioAttachmentPaths: ["/tmp/demo.wav"],
      },
    );
  });

  it("keeps inline-only pasted images out of session-file path registration", async () => {
    const promptSession = vi.fn(async () => {});
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const registerSessionFile = vi.fn(() => {
      throw new Error("file not found: /__e2e__/paste.png");
    });
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      registerSessionFile,
    };
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "describe this",
      images: [image],
      displayMessage: {
        text: "describe this",
        attachments: [{
          path: "/__e2e__/paste.png",
          name: "paste.png",
          base64Data: "AAAA",
          mimeType: "image/png",
        }],
      },
    });

    expect(promptSession).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "describe this",
      {
        onExecutionStarted: expect.any(Function),
        images: [image],
      },
    );
    const userEvent = engine.emitEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session_user_message");
    expect(userEvent.message.attachments).toEqual([
      expect.objectContaining({
        path: "/__e2e__/paste.png",
        base64Data: "AAAA",
        mimeType: "image/png",
      }),
    ]);
  });

  it("adds SessionFile references to the prompt without relying on visible attachment paths", async () => {
    const promptSession = vi.fn(async () => {});
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "[attachment] notes.md",
      sessionFileRefs: [{
        fileId: "sf_notes",
        sessionPath: "/tmp/session.jsonl",
        label: "notes.md",
        kind: "attachment",
      }],
    });

    expect(promptSession).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      `[SessionFile] ${JSON.stringify({
        fileId: "sf_notes",
        sessionPath: "/tmp/session.jsonl",
        label: "notes.md",
        kind: "attachment",
      })}\n[attachment] notes.md`,
      { onExecutionStarted: expect.any(Function) },
    );
  });

  it("passes selected workspace tool context to the model and live user message", async () => {
    const promptSession = vi.fn(async () => {});
    const session = {
      subscribe: vi.fn(() => vi.fn()),
      sessionManager: { getCwd: vi.fn(() => "E:/Codia") },
    };
    const workspaceTool = {
      id: "research",
      title: "研究模式",
      description: "引用溯源、可信度、可导出报告",
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      setUiContext: vi.fn(),
    };

    await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "这个工具是干嘛用的",
      uiContext: { workspaceTool },
      displayMessage: {
        text: "这个工具是干嘛用的",
        workspaceTool,
      },
    });

    expect(engine.setUiContext).toHaveBeenCalledWith("/tmp/session.jsonl", { workspaceTool });
    expect(promptSession).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      "这个工具是干嘛用的",
      expect.objectContaining({
        context: expect.objectContaining({
          system: expect.stringContaining("Research Mode is active"),
          metadata: expect.objectContaining({
            source: "desktop-ui-context+workspace-tool",
            workspaceTool: expect.objectContaining({
              id: "research",
              operation: "research_mode",
              backendRoute: "/api/prompts/research",
            }),
          }),
        }),
      }),
    );
    expect(promptSession.mock.calls[0][2].context.system).toContain("this tool");
    expect(promptSession.mock.calls[0][2].context.system).toContain("web_search");
    expect(promptSession.mock.calls[0][2].context.beforeUser).toBeUndefined();
    const userEvent = engine.emitEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session_user_message");
    expect(userEvent.message.workspaceTool).toEqual(workspaceTool);
  });

  it("appends settings update summaries into captured bridge text", async () => {
    const subscribers = [];
    const session = {
      subscribe: vi.fn((fn) => {
        subscribers.push(fn);
        return vi.fn();
      }),
    };
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession: vi.fn(async () => {
        for (const fn of subscribers) {
          fn({
            type: "tool_execution_end",
            isError: false,
            result: {
              details: {
                settingsUpdate: {
                  status: "applied",
                  action: "core.apply",
                  key: "locale",
                  title: "Locale updated",
                  summary: "Locale changed.",
                  changes: [{ key: "locale", label: "Locale", before: "zh-CN", after: "en" }],
                },
              },
            },
          });
        }
      }),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    const result = await submitDesktopSessionMessage(engine, {
      sessionPath: "/tmp/session.jsonl",
      text: "change locale",
    });

    expect(result.text).toContain("Locale updated");
    expect(result.text).toContain("Locale: zh-CN -> en");
  });

  it("stores very long user turns as current-session files before prompting the model", async () => {
    const sessionPath = makeSessionPath();
    const promptSession = vi.fn(async () => {});
    const session = { subscribe: vi.fn(() => vi.fn()) };
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_long_context",
      sessionPath,
      filePath,
      realPath: filePath,
      displayName: label,
      filename: path.basename(filePath),
      label,
      ext: "md",
      mime: "text/markdown",
      size: fs.statSync(filePath).size,
      kind: "document",
      origin,
      storageKind,
      status: "available",
      missingAt: null,
      createdAt: 1,
    }));
    const engine = {
      codiaHome: tmpDir,
      ensureSessionLoaded: vi.fn(async () => session),
      promptSession,
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
      registerSessionFile,
    };
    const longText = `alpha-start\n${"middle-block ".repeat(12_000)}\nomega-end`;

    await submitDesktopSessionMessage(engine, {
      sessionPath,
      text: longText,
    });

    expect(registerSessionFile).toHaveBeenCalledWith({
      sessionPath,
      filePath: expect.stringContaining(path.join(tmpDir, "session-files")),
      label: "long-user-message.md",
      origin: "user_long_context",
      storageKind: "managed_cache",
    });
    const savedPath = registerSessionFile.mock.calls[0][0].filePath;
    expect(fs.readFileSync(savedPath, "utf-8")).toBe(longText);

    const sentText = promptSession.mock.calls[0][1];
    expect(sentText.length).toBeLessThan(20_000);
    expect(sentText).toContain("[long_context_file:");
    expect(sentText).toContain(savedPath);
    expect(sentText).toContain("sf_long_context");
    expect(sentText).toContain("alpha-start");
    expect(sentText).toContain("omega-end");
    expect(sentText).not.toContain("middle-block ".repeat(2_000));

    const userEvent = engine.emitEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session_user_message");
    expect(userEvent.message.text).toBe(longText);
    expect(userEvent.message.attachments).toEqual([
      expect.objectContaining({
        fileId: "sf_long_context",
        path: savedPath,
        name: "long-user-message.md",
        mimeType: "text/markdown",
      }),
    ]);
  });
});
