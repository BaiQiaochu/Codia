// shared/migrate-config-scope.js

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { CONFIG_SCHEMA } from "./config-schema.ts";

type JsonRecord = Record<string, any>;

type PreferencesStore = {
  getPreferences: () => JsonRecord;
  savePreferences: (preferences: JsonRecord) => void;
};

type AgentConfigEntry = {
  id: string;
  path: string;
  config: JsonRecord;
  content: string;
};

/**
 * One-shot migration that lifts global-scope fields out of agent config.yaml
 * into preferences.json, then removes those fields from each agent config.
 */
export function migrateConfigScope({
  agentsDir,
  prefs,
  primaryAgentId,
  log = (_message: string) => {},
}: {
  agentsDir: string;
  prefs: PreferencesStore;
  primaryAgentId?: string;
  log?: (message: string) => void;
}) {
  const preferences = prefs.getPreferences();

  if (preferences._configScopeMigrated) return;

  log("[migrate] config scope migration started...");

  const agentConfigs: AgentConfigEntry[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const content = fs.readFileSync(cfgPath, "utf-8");
        const config = (YAML.load(content) || {}) as JsonRecord;
        agentConfigs.push({ id: entry.name, path: cfgPath, config, content });
      } catch {
        // Skip unreadable agent configs; startup should not be blocked here.
      }
    }
  } catch {
    return;
  }

  if (agentConfigs.length === 0) {
    preferences._configScopeMigrated = true;
    prefs.savePreferences(preferences);
    return;
  }

  agentConfigs.sort((a, b) => {
    if (a.id === primaryAgentId) return -1;
    if (b.id === primaryAgentId) return 1;
    return 0;
  });

  const readPath = (obj: JsonRecord, parts: string[]) => {
    let cur = obj;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  };

  const writePath = (obj: JsonRecord, parts: string[], value: unknown) => {
    if (parts.length === 1) {
      obj[parts[0]] = value;
      return;
    }
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
      cur = cur[part];
    }
    cur[parts[parts.length - 1]] = value;
  };

  let prefsChanged = false;
  for (const [schemaPath, def] of Object.entries(CONFIG_SCHEMA)) {
    if (def.scope !== "global") continue;

    const agentParts = schemaPath.split(".");
    const prefsParts = (def.prefsPath || schemaPath).split(".");
    const defaultVal = def.defaultValue;
    const prefsValue = readPath(preferences, prefsParts);
    const prefsHasValue = prefsValue !== undefined && prefsValue !== defaultVal;
    if (prefsHasValue) continue;

    for (const ac of agentConfigs) {
      const agentValue = readPath(ac.config, agentParts);
      if (agentValue === undefined || agentValue === defaultVal) continue;
      writePath(preferences, prefsParts, agentValue);
      prefsChanged = true;
      log(`[migrate] ${schemaPath}: ${JSON.stringify(agentValue)} migrated from agent "${ac.id}" to preferences`);
      break;
    }
  }

  for (const ac of agentConfigs) {
    let changed = false;
    for (const schemaPath of Object.keys(CONFIG_SCHEMA)) {
      const parts = schemaPath.split(".");
      if (parts.length === 1 && parts[0] in ac.config) {
        delete ac.config[parts[0]];
        changed = true;
      } else if (parts.length === 2 && ac.config[parts[0]]?.[parts[1]] !== undefined) {
        delete ac.config[parts[0]][parts[1]];
        if (Object.keys(ac.config[parts[0]]).length === 0) {
          delete ac.config[parts[0]];
        }
        changed = true;
      }
    }

    if (changed) {
      const backupPath = ac.path + ".pre-scope-migration";
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, ac.content, "utf-8");
      }
      fs.writeFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }), "utf-8");
      log(`[migrate] cleaned global fields from ${ac.id}/config.yaml`);
    }
  }

  preferences._configScopeMigrated = true;
  prefs.savePreferences(preferences);

  if (prefsChanged) log("[migrate] preferences updated from agent config");
  log("[migrate] config scope migration completed");
}
