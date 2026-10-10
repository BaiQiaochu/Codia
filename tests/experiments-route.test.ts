// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createExperimentsRoute } from "../server/routes/experiments.js";
import {
  CACHE_SNAPSHOT_EXPERIMENT_ID,
  COMPACTION_MODE_EXPERIMENT_ID,
  DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
  PROACTIVE_SUBAGENT_EXPERIMENT_ID,
} from "../lib/experiments/registry.js";
import {
  readCacheSnapshotObservation,
  writeCacheSnapshotObservation,
} from "../lib/memory/cache-snapshot-observation.js";

function makeEngine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-experiments-route-"));
  const agentsDir = path.join(root, "agents");
  const prefsState = {};
  return {
    root,
    engine: {
      agentsDir,
      preferences: {
        getExperimentValue: (id) => prefsState[id],
        setExperimentValue: (id, value) => {
          prefsState[id] = value;
        },
      },
      getAgentDir: (agentId) => path.join(agentsDir, agentId),
    },
  };
}

async function routeFetch(route, pathName, init) {
  const res = await route.request(`http://localhost${pathName}`, init);
  const body = await res.json();
  return { status: res.status, body };
}

describe("experiments route", () => {
  it("returns registry definitions with resolved values", async () => {
    const { engine } = makeEngine();
    const route = createExperimentsRoute(engine);

    const { status, body } = await routeFetch(route, "/experiments");

    expect(status).toBe(200);
    const entry = body.experiments.find((item) => item.id === CACHE_SNAPSHOT_EXPERIMENT_ID);
    expect(entry).toBeUndefined();
    const compactionEntry = body.experiments.find((item) => item.id === COMPACTION_MODE_EXPERIMENT_ID);
    expect(compactionEntry.value).toBe("auto");
    expect(compactionEntry.valueSchema.presentation.type).toBe("select");
    const deepseekEntry = body.experiments.find((item) => item.id === DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID);
    expect(deepseekEntry.value).toBe(false);
    expect(deepseekEntry.valueSchema.presentation.type).toBe("toggle");
    const proactiveEntry = body.experiments.find((item) => item.id === PROACTIVE_SUBAGENT_EXPERIMENT_ID);
    expect(proactiveEntry.value).toBe(false);
    expect(proactiveEntry.valueSchema.presentation.type).toBe("toggle");
  });

  it("updates known experiment ids and rejects unknown ids", async () => {
    const { engine } = makeEngine();
    const route = createExperimentsRoute(engine);

    const ok = await routeFetch(route, `/experiments/${encodeURIComponent(CACHE_SNAPSHOT_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "shadow" }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe("off");

    const deepseek = await routeFetch(route, `/experiments/${encodeURIComponent(DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(deepseek.status).toBe(200);
    expect(deepseek.body.value).toBe(true);

    const bad = await routeFetch(route, "/experiments/unknown.flag", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown experiment id/);
  });

  it("stores observation under the agent experiment directory and requires agentId for reads", async () => {
    const { engine } = makeEngine();
    const agentDir = engine.getAgentDir("codia");
    writeCacheSnapshotObservation(agentDir, {
      version: 1,
      agentId: "codia",
      sessionPath: "/tmp/session.jsonl",
      trigger: "threshold",
      createdAt: "2026-06-03T00:00:00.000Z",
      mode: "shadow",
      status: "success",
      reason: "",
      usage: { model: "test", cachedTokens: 1, missTokens: 2, latencyMs: 3 },
      summaryPreview: "facts",
      memoryMdPreview: "memory preview",
      baseMemoryMdHash: "base",
      cachePrefixHash: "prefix",
    });

    expect(readCacheSnapshotObservation(agentDir).memoryMdPreview).toContain("memory");

    const route = createExperimentsRoute(engine);
    const missing = await routeFetch(route, "/experiments/memory/cache-snapshot-reflection/observation");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/agentId/);

    const ok = await routeFetch(route, "/experiments/memory/cache-snapshot-reflection/observation?agentId=codia");
    expect(ok.status).toBe(200);
    expect(ok.body.observation.memoryMdPreview).toContain("memory");

    const deleted = await routeFetch(route, "/experiments/memory/cache-snapshot-reflection/observation?agentId=codia", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect(readCacheSnapshotObservation(agentDir)).toBeNull();
  });
});
