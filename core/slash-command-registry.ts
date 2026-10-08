// @ts-nocheck
import { createModuleLogger } from "../lib/debug-log.ts";

const log = createModuleLogger("slash");
const MAX_COMMAND_NAME_LENGTH = 32;

function normalize(raw) {
  const s = String(raw ?? "").trim().toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, MAX_COMMAND_NAME_LENGTH);
  return s.replace(/^_+|_+$/g, "").replace(/_+/g, "_");
}

export class SlashCommandRegistry {
  static CORE_RESERVED_NAMES = new Set([
    "stop",
    "new",
    "reset",
    "compact",
    "fresh_compact",
    "help",
    "status",
    "rc",
    "exitrc",
    "confirm",
    "reject",
    "approve",
    "deny",
  ]);

  constructor() {
    this._byName = new Map();
    this._bySource = new Map();
  }

  registerCommand(def, meta = {}) {
    const base = normalize(def.name);
    if (!base) throw new Error("Command name required");

    const gateSource = meta.source ?? "core";
    const sourceId = meta.sourceId ?? def.sourceId ?? null;
    if (gateSource !== "core" && SlashCommandRegistry.CORE_RESERVED_NAMES.has(base)) {
      log.warn(`rejected register: "${base}" is core-reserved (source=${gateSource}${sourceId ? `, sourceId=${sourceId}` : ""})`);
      return null;
    }

    const source = meta.source ?? def.source ?? "core";
    let finalName = base;
    let i = 2;
    while (this._byName.has(finalName)) finalName = `${base}_${i++}`;

    const stored = { ...def, name: finalName, source, sourceId };
    this._byName.set(finalName, stored);

    for (const alias of (def.aliases || [])) {
      const normalizedAlias = normalize(alias);
      if (!normalizedAlias) continue;
      if (gateSource !== "core" && SlashCommandRegistry.CORE_RESERVED_NAMES.has(normalizedAlias)) {
        log.warn(`rejected alias "${normalizedAlias}" for "${finalName}": core-reserved (source=${gateSource}${sourceId ? `, sourceId=${sourceId}` : ""})`);
        continue;
      }
      if (this._byName.has(normalizedAlias)) {
        log.warn(`alias "${normalizedAlias}" for command "${finalName}" skipped (name already taken)`);
        continue;
      }
      this._byName.set(normalizedAlias, stored);
    }

    const sourceKey = `${source}:${sourceId || ""}`;
    if (!this._bySource.has(sourceKey)) this._bySource.set(sourceKey, new Set());
    this._bySource.get(sourceKey).add(finalName);
    return { name: finalName, sourceKey };
  }

  unregisterCommand(handle) {
    const def = this._byName.get(handle.name);
    if (!def) return false;

    this._byName.delete(handle.name);
    for (const alias of (def.aliases || [])) {
      const normalizedAlias = normalize(alias);
      if (this._byName.get(normalizedAlias) === def) this._byName.delete(normalizedAlias);
    }

    const sourceKey = `${def.source}:${def.sourceId || ""}`;
    this._bySource.get(sourceKey)?.delete(handle.name);
    return true;
  }

  unregisterBySource(source, sourceId) {
    const sourceKey = `${source}:${sourceId || ""}`;
    const names = this._bySource.get(sourceKey);
    if (!names) return 0;

    let count = 0;
    for (const name of Array.from(names)) {
      if (this.unregisterCommand({ name, sourceKey })) count += 1;
    }
    this._bySource.delete(sourceKey);
    return count;
  }

  lookup(rawName) {
    return this._byName.get(normalize(rawName)) || null;
  }

  list() {
    return Array.from(new Set(this._byName.values())).map((def) => ({ ...def }));
  }
}
