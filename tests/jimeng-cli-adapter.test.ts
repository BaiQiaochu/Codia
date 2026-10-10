import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJimengImageAdapter,
  createJimengVideoAdapter,
  parseDreaminaTaskOutput,
  resolveDreaminaCommand,
} from "../plugins/jimeng-cli/adapters/dreamina.ts";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codia-jimeng-cli-"));
}

describe("Jimeng CLI command resolution", () => {
  it("uses DREAMINA_CLI_PATH before PATH lookup", () => {
    const exists = vi.fn((filePath: string) => filePath === "/opt/dreamina");

    expect(resolveDreaminaCommand({
      env: { DREAMINA_CLI_PATH: "/opt/dreamina", PATH: "/usr/bin" },
      exists,
      which: () => null,
      homeDir: "/home/codia",
      platform: "linux",
    })).toBe("/opt/dreamina");
    expect(exists).toHaveBeenCalledWith("/opt/dreamina");
  });

  it("returns null when dreamina is not installed", () => {
    expect(resolveDreaminaCommand({
      env: { PATH: "/usr/bin" },
      exists: () => false,
      which: () => null,
      homeDir: "/home/codia",
      platform: "linux",
    })).toBeNull();
  });
});

describe("Jimeng CLI output parsing", () => {
  it("parses JSON task output", () => {
    expect(parseDreaminaTaskOutput('{"submit_id":"abc123","gen_status":"querying"}')).toEqual({
      submitId: "abc123",
      status: "querying",
      failReason: null,
    });
  });

  it("parses text task output", () => {
    expect(parseDreaminaTaskOutput("submit_id: abc123\ngen_status: success")).toEqual({
      submitId: "abc123",
      status: "success",
      failReason: null,
    });
  });
});

describe("Jimeng CLI adapters", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("submits text-to-image through dreamina without shell execution", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ submit_id: "img-task", gen_status: "querying" }),
      stderr: "",
    }));
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    const result = await adapter.submit({
      prompt: "a cat",
      ratio: "1:1",
      resolution: "2k",
      model: "jimeng-image-5.0",
    }, { generatedDir: "/tmp/out" } as any);

    expect(result).toEqual({ taskId: "img-task" });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "text2image",
      "--prompt",
      "a cat",
      "--model_version",
      "5.0",
      "--ratio",
      "1:1",
      "--resolution_type",
      "2k",
      "--poll",
      "0",
    ], expect.objectContaining({ shell: false }));
  });

  it("rejects unsupported Jimeng image resolution before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengImageAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "a cat",
      model: "jimeng-image-5.0",
      resolution: "1k",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/Jimeng.*resolution.*1k/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("allows Dreamina 1080p only on seedance2.0_vip", async () => {
    const run = vi.fn(async () => ({
      stdout: "submit_id: vid-task\ngen_status: querying",
      stderr: "",
    }));
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await adapter.submit({
      prompt: "rainy street",
      model: "seedance2.0_vip",
      video_resolution: "1080p",
    }, { generatedDir: "/tmp/out" } as any);

    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", expect.arrayContaining([
      "--model_version",
      "seedance2.0_vip",
      "--video_resolution",
      "1080p",
    ]), expect.objectContaining({ shell: false }));
  });

  it("rejects image-only video models for text-to-video before invoking dreamina", async () => {
    const run = vi.fn();
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.submit({
      prompt: "rainy street",
      model: "3.5pro",
    }, { generatedDir: "/tmp/out" } as any)).rejects.toThrow(/text2video/);
    expect(run).not.toHaveBeenCalled();
  });

  it("queries results and returns files downloaded by dreamina", async () => {
    const root = makeTempDir();
    roots.push(root);
    const run = vi.fn(async () => {
      fs.writeFileSync(path.join(root, "dreamina_video_1.mp4"), "video");
      return {
        stdout: JSON.stringify({ submit_id: "vid-task", gen_status: "success" }),
        stderr: "",
      };
    });
    const adapter = createJimengVideoAdapter({
      resolveCommand: () => "/usr/local/bin/dreamina",
      runCommand: run,
    });

    await expect(adapter.query("vid-task", { generatedDir: root } as any)).resolves.toEqual({
      status: "success",
      files: ["dreamina_video_1.mp4"],
    });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/dreamina", [
      "query_result",
      "--submit_id",
      "vid-task",
      "--download_dir",
      root,
    ], expect.objectContaining({ shell: false }));
  });
});
