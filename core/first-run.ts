// @ts-nocheck
/**
 * first-run.js -首次运行播种
 *
 * -server/engine 启动之前调用，确保数据目录结构存在- * 如果是全新安装（agents/ 为空），自动创建默认 agent- */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeCopyDir } from '../shared/safe-fs.ts';
import { AppError } from '../shared/errors.ts';
import { errorBus } from '../shared/error-bus.ts';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  ensureDefaultWorkspace,
} from "../shared/default-workspace.ts";
import { USER_PROFILE_FILENAME } from "../lib/user-profile-store.ts";

const DEFAULT_AGENT_ID = "gsap";
const LEGACY_IMPORTED_SKILL_MARKER = ".hermes-import.json";
const LEGACY_AGENT_ID = ["h", "anako"].join("");
const LEGACY_PRODUCT_ID = ["open", LEGACY_AGENT_ID].join("");
const LEGACY_DEFAULT_AGENT_NAMES = new Set([
  LEGACY_AGENT_ID,
  LEGACY_PRODUCT_ID,
  "g-sap",
  "gsap",
  "星河智域",
]);

function hasAgentConfig(agentsDir, agentId) {
  return fs.existsSync(path.join(agentsDir, agentId, "config.yaml"));
}

function findFirstAgentWithConfig(agentsDir) {
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (hasAgentConfig(agentsDir, entry.name)) return entry.name;
    }
  } catch {
    // Ignore; callers will handle a null fallback.
  }
  return null;
}

function neutralizeLegacyDefaultIdentity(agentDir) {
  const identityPath = path.join(agentDir, "identity.md");
  if (!fs.existsSync(identityPath)) return;
  const current = fs.readFileSync(identityPath, "utf-8");
  const updated = current.replace(
    /^(\uFEFF?)#[ \t]*(?:G-SAP|GSAP|星河智域)[ \t]*(\r?\n|$)/u,
    "$1# 小豆蔻$2",
  );
  if (updated !== current) fs.writeFileSync(identityPath, updated, "utf-8");
}

function repairPrimaryAgentPreference(gsapHome, agentsDir) {
  const prefsPath = path.join(gsapHome, "user", "preferences.json");
  let prefs = {};
  try {
    if (fs.existsSync(prefsPath)) {
      prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")) || {};
    }
  } catch {
    prefs = {};
  }

  const primary = prefs.primaryAgent;
  if (primary && hasAgentConfig(agentsDir, primary)) return;

  const fallback = hasAgentConfig(agentsDir, DEFAULT_AGENT_ID)
    ? DEFAULT_AGENT_ID
    : findFirstAgentWithConfig(agentsDir);
  if (!fallback) return;

  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(
    prefsPath,
    JSON.stringify({ ...prefs, primaryAgent: fallback }, null, 2) + "\n",
    "utf-8",
  );
}

function migrateLegacyAgentIdsAndYuan(gsapHome) {
  const agentsDir = path.join(gsapHome, "agents");
  const legacyAgentDir = path.join(agentsDir, LEGACY_AGENT_ID);
  const defaultAgentDir = path.join(agentsDir, DEFAULT_AGENT_ID);
  const prefsPath = path.join(gsapHome, "user", "preferences.json");

  if (fs.existsSync(legacyAgentDir) && !fs.existsSync(defaultAgentDir)) {
    fs.renameSync(legacyAgentDir, defaultAgentDir);
  }

  if (fs.existsSync(prefsPath)) {
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      if (prefs.primaryAgent === LEGACY_AGENT_ID) {
        prefs.primaryAgent = DEFAULT_AGENT_ID;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
      }
    } catch {
      // Ignore malformed preferences here; later code handles normal defaults.
    }
  }

  if (!fs.existsSync(agentsDir)) return;
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === DEFAULT_AGENT_ID) {
      neutralizeLegacyDefaultIdentity(path.join(agentsDir, entry.name));
    }
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
      let changed = false;
      if (raw?.agent?.yuan === LEGACY_AGENT_ID) {
        raw.agent = { ...(raw.agent || {}), yuan: "gsap" };
        changed = true;
      }
      const agentName = String(raw?.agent?.name || "").trim().toLowerCase();
      if (
        entry.name === DEFAULT_AGENT_ID
        && LEGACY_DEFAULT_AGENT_NAMES.has(agentName)
      ) {
        raw.agent = { ...(raw.agent || {}), name: "小豆蔻" };
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(
          configPath,
          YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
          "utf-8",
        );
      }
    } catch {
      // Leave malformed config files untouched; later config loading reports them.
    }
  }
}

/**
  *
 * @param {string} gsapHome - 数据目录绝对路径
 * @param {string} productDir - 产品模板目录（lib/- */
export function ensureFirstRun(gsapHome, productDir, { defaultWorkspaceHome } = {}) {
 // 1. 确保目录结构存在
  fs.mkdirSync(path.join(gsapHome, "agents"), { recursive: true });
  fs.mkdirSync(path.join(gsapHome, "user"), { recursive: true });
  migrateLegacyAgentIdsAndYuan(gsapHome);

 // 2. 如果 agents/ 没有任何 agent -播种默认 agent
  const agentsDir = path.join(gsapHome, "agents");
  const hasAgent = fs.readdirSync(agentsDir, { withFileTypes: true }).some(entry => {
    return entry.isDirectory() && !entry.name.startsWith('.') && hasAgentConfig(agentsDir, entry.name);
  });

  if (!hasAgent) {
    console.log("[first-run] no agent found; creating the default agent...");
    seedDefaultAgent(agentsDir, productDir, defaultWorkspaceHome);
  }

  if (hasAgent && !hasAgentConfig(agentsDir, DEFAULT_AGENT_ID)) {
    console.log("[first-run] default agent config missing; repairing...");
    seedDefaultAgent(agentsDir, productDir, defaultWorkspaceHome);
  }

 // 3. 同步 skills：从 skills2set/ 复制到数据目-skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(gsapHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
  }

 // 4. 确保可文件存在（老用户升-+ -agent 都覆盖）
  const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
  touchIfMissing(path.join(gsapHome, 'user', USER_PROFILE_FILENAME));
  const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of agents) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    touchIfMissing(path.join(agentsDir, entry.name, 'pinned.md'));
  }

 // 5. 确保 user/preferences.json 存在
  const prefsPath = path.join(gsapHome, "user", "preferences.json");
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        primaryAgent: DEFAULT_AGENT_ID,
      }, null, 2) + "\n",
      "utf-8",
    );
  }
  repairPrimaryAgentPreference(gsapHome, agentsDir);
}

/**
  * */
function seedDefaultAgent(agentsDir, productDir, defaultWorkspaceHome) {
  const agentId = DEFAULT_AGENT_ID;
  const agentDir = path.join(agentsDir, agentId);

  //
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });

 //
  const cfgDest = path.join(agentDir, "config.yaml");
  const configSrc = path.join(productDir, "config.example.yaml");
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, cfgDest);
  }
 //
  try {
    const raw = fs.existsSync(cfgDest) ? YAML.load(fs.readFileSync(cfgDest, "utf-8")) || {} : {};
    raw.desk = {
      ...(raw.desk || {}),
      home_folder: ensureDefaultWorkspace(defaultWorkspaceHome),
      heartbeat_enabled: false,
      heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    };
    raw.memory = {
      ...(raw.memory || {}),
      enabled: true,
    };
    fs.writeFileSync(cfgDest, YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }), "utf-8");
  } catch {}


 // identity.md（填入默认名字）
  const identitySrc = path.join(productDir, "identity.example.md");
  if (fs.existsSync(identitySrc)) {
    const tmpl = fs.readFileSync(identitySrc, "utf-8");
    const filled = tmpl
      .replace(/\{\{agentName\}\}/g, "小豆蔻")
      .replace(/\{\{userName\}\}/g, "");
    fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
  }

 //

  // ishiki.md
  const ishikiSrc = path.join(productDir, "ishiki.example.md");
  if (fs.existsSync(ishikiSrc)) {
    fs.copyFileSync(ishikiSrc, path.join(agentDir, "ishiki.md"));
  }

 // public-ishiki.md（对外意识模板）
  const publicIshikiSrc = path.join(productDir, "public-ishiki-templates", `${agentId}.md`);
  if (fs.existsSync(publicIshikiSrc)) {
    fs.copyFileSync(publicIshikiSrc, path.join(agentDir, "public-ishiki.md"));
  }

  console.log(`[first-run] 默认助手 "${agentId}" 已创建`);
}

/**
 * 同步 skills2set/ -数据目录 skills/
 * 每次启动都跑，确保新-更新-skill 能同步到用户目录
 */
function syncSkills(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  const bundledSkillNames = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillSrc = path.join(srcDir, entry.name);
    const skillDst = path.join(dstDir, entry.name);

 // 只要源里-SKILL.md 就同步整个目-
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) continue;
    bundledSkillNames.add(entry.name);

    try {
      safeCopyDir(skillSrc, skillDst);
    } catch (err) {
      errorBus.report(new AppError('SKILL_SYNC_FAILED', {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { skill: entry.name },
      }));
      // Continue with other skills, don't abort
    }
  }

 // 清理旧版本曾经批量导入但当前已不再随主程序发布的 Hermes 抢能- // 只删除带 .hermes-import.json 标记的目录，避免误删用户自己安装的技能-
  for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || bundledSkillNames.has(entry.name)) continue;
    const skillDir = path.join(dstDir, entry.name);
    const markerPath = path.join(skillDir, LEGACY_IMPORTED_SKILL_MARKER);
    if (!fs.existsSync(markerPath)) continue;
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
    } catch (err) {
      errorBus.report(new AppError('SKILL_SYNC_FAILED', {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { skill: entry.name, operation: "prune legacy imported skill" },
      }));
    }
  }
}
