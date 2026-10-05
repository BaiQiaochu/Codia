import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createScopedConfigAccessor } from "../lib/scoped-config.js";

describe("image-gen scoped config", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-gen-config-"));

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  it("reads agent-scoped config before falling back to global config", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "config.json"),
      JSON.stringify({ defaultImageModel: { id: "global-model", provider: "openai" } }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpRoot, "agents", "hana"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "agents", "hana", "config.json"),
      JSON.stringify({ defaultImageModel: { id: "gsap-model", provider: "openai" } }),
      "utf-8",
    );

    const scoped = createScopedConfigAccessor({ dataDir: tmpRoot }, "hana");
    expect(scoped.get("defaultImageModel")).toEqual({ id: "gsap-model", provider: "openai" });
  });

  it("writes agent-scoped config into agents/<id>/config.json", () => {
    const scoped = createScopedConfigAccessor({ dataDir: tmpRoot }, "worker-a");
    scoped.set("providerDefaults", { openai: { quality: "high" } });

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, "agents", "worker-a", "config.json"), "utf-8"),
    );
    expect(saved.providerDefaults.openai.quality).toBe("high");
  });

  it("reads and writes plugin-manager scoped config files", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        global: {
          defaultImageModel: { id: "global-model", provider: "openai" },
        },
        agents: {
          hana: {
            defaultVideoModel: { id: "agent-video", provider: "volcengine" },
          },
        },
        sessions: {},
      }),
      "utf-8",
    );

    const scoped = createScopedConfigAccessor({ dataDir: tmpRoot }, "hana");

    expect(scoped.get("defaultImageModel")).toEqual({ id: "global-model", provider: "openai" });
    expect(scoped.get("defaultVideoModel")).toEqual({ id: "agent-video", provider: "volcengine" });
    expect(scoped.get()).toMatchObject({
      defaultImageModel: { id: "global-model", provider: "openai" },
      defaultVideoModel: { id: "agent-video", provider: "volcengine" },
    });

    scoped.set("defaultVideoModel", null);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
    expect(saved.agents.hana.defaultVideoModel).toBeNull();
  });

  it("does not let legacy agent media defaults override plugin-state defaults", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        global: {
          defaultImageModel: { id: "gpt-image-2", provider: "kskooo" },
          defaultAudioModel: { id: "tts-plus", provider: "custom-audio" },
        },
        agents: {
          gsap: {
            defaultMusicModel: { id: "song-plus", provider: "custom-music" },
            defaultVideoModel: { id: "motion-plus", provider: "custom-video" },
          },
        },
        sessions: {},
      }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpRoot, "agents", "gsap"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "agents", "gsap", "config.json"),
      JSON.stringify({
        defaultImageModel: { id: "image-01", provider: "minimax" },
        defaultAudioModel: { id: "old-audio", provider: "legacy" },
        defaultMusicModel: { id: "old-music", provider: "legacy" },
        defaultVideoModel: { id: "old-video", provider: "legacy" },
        providerDefaults: { kskooo: { quality: "high" } },
      }),
      "utf-8",
    );

    const scoped = createScopedConfigAccessor({ dataDir: tmpRoot }, "gsap");

    expect(scoped.get("defaultImageModel")).toEqual({ id: "gpt-image-2", provider: "kskooo" });
    expect(scoped.get("defaultAudioModel")).toEqual({ id: "tts-plus", provider: "custom-audio" });
    expect(scoped.get("defaultMusicModel")).toEqual({ id: "song-plus", provider: "custom-music" });
    expect(scoped.get("defaultVideoModel")).toEqual({ id: "motion-plus", provider: "custom-video" });
    expect(scoped.get("providerDefaults")).toEqual({ kskooo: { quality: "high" } });
  });

  it("removes same-name legacy media defaults when writing plugin-state agent defaults", () => {
    fs.writeFileSync(
      path.join(tmpRoot, "config.json"),
      JSON.stringify({ schemaVersion: 1, global: {}, agents: {}, sessions: {} }),
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpRoot, "agents", "gsap"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "agents", "gsap", "config.json"),
      JSON.stringify({
        defaultVideoModel: { id: "old-video", provider: "legacy" },
        providerDefaults: { custom: { quality: "high" } },
      }),
      "utf-8",
    );

    const scoped = createScopedConfigAccessor({ dataDir: tmpRoot }, "gsap");
    scoped.set("defaultVideoModel", { id: "motion-plus", provider: "custom-video" });

    const savedPluginState = JSON.parse(fs.readFileSync(path.join(tmpRoot, "config.json"), "utf-8"));
    const savedLegacy = JSON.parse(fs.readFileSync(path.join(tmpRoot, "agents", "gsap", "config.json"), "utf-8"));
    expect(savedPluginState.agents.gsap.defaultVideoModel).toEqual({ id: "motion-plus", provider: "custom-video" });
    expect(savedLegacy.defaultVideoModel).toBeUndefined();
    expect(savedLegacy.providerDefaults).toEqual({ custom: { quality: "high" } });
  });
});
