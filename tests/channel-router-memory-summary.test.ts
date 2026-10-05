import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callTextMock, factAddMock, factGetBySessionMock, factDeleteMock } = vi.hoisted(() => ({
  callTextMock: vi.fn(),
  factAddMock: vi.fn(),
  factGetBySessionMock: vi.fn(),
  factDeleteMock: vi.fn(),
}));

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "en-US",
  t: (key) => key,
}));

vi.mock("../core/llm-client.js", () => ({
  callText: callTextMock,
}));

vi.mock("../lib/memory/fact-store.js", () => ({
  FactStore: vi.fn(function FactStoreMock() {
    this.add = factAddMock;
    this.getBySession = factGetBySessionMock;
    this.delete = factDeleteMock;
    this.close = vi.fn();
  }),
}));

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  createModuleLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ChannelRouter } from "../hub/channel-router.js";

let rootDir;

function writeAgentFixture(memoryEnabled) {
  const agentsDir = path.join(rootDir, "agents");
  const agentDir = path.join(agentsDir, "nova");
  const userDir = path.join(rootDir, "user");
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      "  name: Nova",
      "  yuan: gsap",
      "memory:",
      `  enabled: ${memoryEnabled ? "true" : "false"}`,
    ].join("\n"),
    "utf-8",
  );
  return { agentsDir, userDir };
}

function writeAgentConfig(agentsDir, agentId, name) {
  const agentDir = path.join(agentsDir, agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "config.yaml"),
    [
      "agent:",
      `  name: ${name}`,
      "memory:",
      "  enabled: true",
    ].join("\n"),
    "utf-8",
  );
}

function createRouter(paths) {
  return new ChannelRouter({
    hub: {
      engine: {
        agentsDir: paths.agentsDir,
        channelsDir: path.join(rootDir, "channels"),
        productDir: path.join(rootDir, "product"),
        userDir: paths.userDir,
        userName: "Owner",
        agents: undefined,
        getAgent: () => null,
        resolveUtilityConfig: () => ({
          utility: "test-model",
          api_key: "test-key",
          base_url: "https://test.api",
          api: "openai-completions",
        }),
      },
      eventBus: { emit: vi.fn() },
    },
  });
}

describe("ChannelRouter channel memory summaries", () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-channel-memory-"));
    callTextMock.mockReset();
    factAddMock.mockReset();
    factGetBySessionMock.mockReset();
    factDeleteMock.mockReset();
    factGetBySessionMock.mockReturnValue([]);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("skips channel memory writes when memory is disabled in config.yaml", async () => {
    const paths = writeAgentFixture(false);
    const router = createRouter(paths);
    callTextMock.mockResolvedValue("summary");

    await router._memorySummarize("nova", "general", "durable context");

    expect(callTextMock).not.toHaveBeenCalled();
    expect(factAddMock).not.toHaveBeenCalled();
  });

  it("uses display names instead of raw sender ids when summarizing structured channel messages", async () => {
    const paths = writeAgentFixture(true);
    writeAgentConfig(paths.agentsDir, "mika", "Mika");
    writeAgentConfig(paths.agentsDir, "rin", "Rin");
    const router = createRouter(paths);
    callTextMock.mockResolvedValue("Mika cleaned the summary; Rin added validation; Nova organized the plan.");

    await router._memorySummarize("nova", "crew", {
      messages: [
        { sender: "user", timestamp: "2026-05-14 09:59:00", body: "Please clean the memory summary." },
        { sender: "mika", timestamp: "2026-05-14 10:00:00", body: "I will clean the summary." },
        { sender: "rin", timestamp: "2026-05-14 10:01:00", body: "Add a regression test too." },
      ],
      replyContent: "I will organize this path.",
    });

    const request = callTextMock.mock.calls[0][0];
    expect(request.systemPrompt).toMatch(/who did what/i);
    expect(request.systemPrompt).toContain("NO_MEMORY");
    expect(request.messages[0].content).toContain("Owner: Please clean the memory summary.");
    expect(request.messages[0].content).toContain("Mika: I will clean the summary.");
    expect(request.messages[0].content).toContain("Rin: Add a regression test too.");
    expect(request.messages[0].content).toContain("[My reply] Nova: I will organize this path.");
    expect(request.messages[0].content).not.toContain("mika:");
    expect(request.messages[0].content).not.toContain("rin:");
  });

  it("replaces stale channel memory facts instead of accumulating summaries", async () => {
    const paths = writeAgentFixture(true);
    const router = createRouter(paths);
    factGetBySessionMock.mockReturnValue([
      { id: 3, fact: "[#general] mika: stale sender id summary." },
      { id: 5, fact: "[#general] someone changed something, unclear subject." },
    ]);
    callTextMock.mockResolvedValue("Nova confirmed channel memory should record actor actions.");

    await router._memorySummarize("nova", "general", {
      messages: [{ sender: "user", timestamp: "2026-05-14 10:00:00", body: "Summaries must say who did what." }],
    });

    const request = callTextMock.mock.calls[0][0];
    expect(request.messages[0].content).toContain("Existing channel memory");
    expect(request.messages[0].content).toContain("stale sender id summary");
    expect(factGetBySessionMock).toHaveBeenCalledWith("channel-general");
    expect(factDeleteMock).toHaveBeenCalledWith(3);
    expect(factDeleteMock).toHaveBeenCalledWith(5);
    expect(factAddMock).toHaveBeenCalledWith(expect.objectContaining({
      fact: "[#general] Nova confirmed channel memory should record actor actions.",
      session_id: "channel-general",
    }));
  });

  it("clears stale channel memory facts when the summarizer returns NO_MEMORY", async () => {
    const paths = writeAgentFixture(true);
    const router = createRouter(paths);
    factGetBySessionMock.mockReturnValue([{ id: 8, fact: "[#general] stale fact." }]);
    callTextMock.mockResolvedValue("NO_MEMORY");

    await router._memorySummarize("nova", "general", {
      messages: [{ sender: "user", timestamp: "2026-05-14 10:00:00", body: "ok" }],
    });

    expect(factDeleteMock).toHaveBeenCalledWith(8);
    expect(factAddMock).not.toHaveBeenCalled();
  });
});
