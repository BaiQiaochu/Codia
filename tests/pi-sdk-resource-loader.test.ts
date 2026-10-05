import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "../lib/pi-sdk/index.ts";
import { createCompactionGuardExtension } from "../lib/extensions/compaction-guard-ext.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createLoader(extensionFactories: ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-pi-extensions-"));
  temporaryRoots.push(root);
  return new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories,
  });
}

describe("Pi resource loader dynamic extension contract", () => {
  it("loads the compaction guard registered after initialization, and preserves it during plugin replacement", async () => {
    const baseFactory = vi.fn();
    const factories: ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"] = [baseFactory];
    const loader = createLoader(factories);
    await loader.reload();

    // Same sequence as Engine.init -> registerExtensionFactory -> plugin reload.
    const guard = createCompactionGuardExtension();
    const firstPlugin = (pi: any) => pi.on("agent_start", () => undefined);
    factories.push(guard, firstPlugin);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.some((extension) => extension.handlers.has("session_before_compact"))).toBe(true);
    expect(loader.getExtensions().extensions.some((extension) => extension.handlers.has("agent_start"))).toBe(true);

    factories.splice(2, 1, (pi: any) => pi.on("agent_end", () => undefined));
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.filter((extension) => extension.handlers.has("session_before_compact"))).toHaveLength(1);
    expect(loaded.extensions.some((extension) => extension.handlers.has("agent_start"))).toBe(false);
    expect(loaded.extensions.some((extension) => extension.handlers.has("agent_end"))).toBe(true);
  });

  it("keeps disabled built-ins out of the dynamic inline extension list", async () => {
    const builtinFactory = vi.fn();
    const loader = createLoader([{ name: "disabled-builtin", builtin: true, factory: builtinFactory }]);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(builtinFactory).not.toHaveBeenCalled();
  });
});
