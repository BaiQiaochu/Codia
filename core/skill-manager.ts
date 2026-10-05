// @ts-nocheck
/**
  *
 *
  * */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";
import { sourceIdentityForSkill } from "../lib/skills/skill-file-identity.ts";

const HEAVY_DIR_NAMES = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "__pycache__",
  "coverage",
  "venv",
  ".venv",
]);

const SKILL_WATCH_DEPTH = 3;

function createSkillWatchIgnore(rootDir) {
  return (absPath) => {
    const rel = path.relative(rootDir, absPath);
    if (!rel) return false;
    if (/(^|[/\\])\./.test(rel) || /[~#]$/.test(rel)) return true;
    const segments = rel.split(/[/\\]/);
    for (let i = 1; i < segments.length; i += 1) {
      if (HEAVY_DIR_NAMES.has(segments[i])) return true;
    }
    return false;
  };
}

export const __test = { createSkillWatchIgnore, HEAVY_DIR_NAMES, SKILL_WATCH_DEPTH };

function readSkillFileMetadata(skill) {
  if (!skill?.filePath) return null;
  try {
    const content = fs.readFileSync(skill.filePath, "utf-8");
    return parseSkillMetadata(content, skill.name || "");
  } catch {
    return null;
  }
}

function decorateLoadedSkill(skill, hiddenSkills) {
  const meta = readSkillFileMetadata(skill);
  skill.defaultEnabled = meta?.defaultEnabled ?? (skill.defaultEnabled !== false);
  if (meta) {
    skill.disableModelInvocation = meta.disableModelInvocation;
    skill.displayName = meta.displayName;
    skill.displayNames = meta.displayNames;
    skill.shortDescription = meta.shortDescription;
    skill.shortDescriptions = meta.shortDescriptions;
  }
  skill._hidden = hiddenSkills.has(skill.name);
  skill.sourceIdentity = sourceIdentityForSkill(skill);
  return skill;
}

function agentIdForSkillView(agent) {
  if (agent?.agentDir) return path.basename(agent.agentDir);
  return typeof agent?.id === "string" && agent.id.trim() ? agent.id.trim() : null;
}

function skillVisibleToAgent(skill, agent) {
  if (!skill?._agentId) return true;
  return skill._agentId === agentIdForSkillView(agent);
}

export class SkillManager {
  declare _allSkills: any[];

  /**
   * @param {object} opts
    *
  * */
  constructor({ skillsDir, externalPaths = [] }) {
    this.skillsDir = skillsDir;
    this._allSkills = [];
    this._hiddenSkills = new Set();
    this._watcher = null;
    this._reloadTimer = null;
    this._reloadDeps = null; // { resourceLoader, agents, onReloaded }
    this._externalPaths = externalPaths;
    this._externalWatchers = new Map();
  }

  /** 全量 skill 列表 */
  get allSkills() { return this._allSkills; }

  /**
  *
   * @param {Map} agents - agent Map
  *
   */
  init(resourceLoader, agents, hiddenSkills) {
    this._hiddenSkills = hiddenSkills;
    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      decorateLoadedSkill(s, hiddenSkills);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
    this._appendExternalSkills();
  }

 /** */
  syncAgentSkills(agent) {
    if (!agent || agent.runtimeInitialized === false || agent.needsRepair === true) return;
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    const skills = this._allSkills.filter(s =>
      skillVisibleToAgent(s, agent)
      && this._isRuntimeEnabledForAgent(s, enabled)
    );
    agent.setEnabledSkills(skills);
  }

 /** */
  getAllSkills(agent) {
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    return this._allSkills.filter(s =>
      skillVisibleToAgent(s, agent)
      && !s._pluginSkill
      && !s._workspaceSkill
    ).map(s => ({
      name: s.name,
      description: s.description,
      displayName: s.displayName || s.name,
      displayNames: s.displayNames || {},
      shortDescription: s.shortDescription || "",
      shortDescriptions: s.shortDescriptions || {},
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s.source,
      hidden: !!s._hidden,
      enabled: enabled.has(s.name),
      externalLabel: s._externalLabel || null,
      externalPath: s._externalPath || null,
      readonly: !!s._readonly,
      sourceIdentity: s.sourceIdentity || null,
    }));
  }

 /** */
  getRuntimeSkillInfos(agent) {
    const enabled = new Set(agent?.config?.skills?.enabled || []);
    return this._allSkills.filter(s =>
      skillVisibleToAgent(s, agent)
      && !s._pluginSkill
    ).map(s => ({
      name: s.name,
      description: s.description,
      displayName: s.displayName || s.name,
      displayNames: s.displayNames || {},
      shortDescription: s.shortDescription || "",
      shortDescriptions: s.shortDescriptions || {},
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s._workspaceSkill ? "workspace" : s.source,
      hidden: !!s._hidden,
      enabled: this._isRuntimeEnabledForAgent(s, enabled),
      externalLabel: s._externalLabel || null,
      externalPath: s._externalPath || null,
      readonly: !!s._readonly,
      managedBy: s._managedBy || null,
      sourceIdentity: s.sourceIdentity || null,
    }));
  }

 /** */
  getSkillsForAgent(targetAgent) {
    const enabled = new Set(targetAgent?.config?.skills?.enabled || []);
    return {
      skills: this._allSkills.filter(s =>
        skillVisibleToAgent(s, targetAgent)
        &&
        this._isRuntimeEnabledForAgent(s, enabled)
      ),
      diagnostics: [],
    };
  }

  /**
  *
  *
  * */
  computeDefaultEnabledForNewAgent() {
    return this._allSkills
      .filter(s => s.source !== "learned" && s.source !== "external" && s.defaultEnabled !== false)
      .map(s => s.name);
  }

  /**
 * 重新加载 skills（安-删除后调用）
   * @param {object} resourceLoader
   * @param {Map} agents
   */
  async reload(resourceLoader, agents) {
 // 暂时恢复原始 getSkills 以便 reload() 正确扫描
    delete resourceLoader.getSkills;
    await resourceLoader.reload();

    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      decorateLoadedSkill(s, this._hiddenSkills);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
    this._appendExternalSkills();
  }

  /**
  *
   * @param {Map} agents
  *
   */
  watch(resourceLoader, agents, onReloaded) {
    this._reloadDeps = { resourceLoader, agents, onReloaded };
    if (this._watcher) return;
    try {
      this._watcher = chokidar.watch(this.skillsDir, {
        ignoreInitial: true,
        ignored: createSkillWatchIgnore(this.skillsDir),
        depth: SKILL_WATCH_DEPTH,
        persistent: true,
      });
      this._watcher.on("all", () => {
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
      });
      this._watcher.on("error", (err) => {
        console.error("[skill-manager] watcher error:", err.message);
      });
    } catch (err) {
      console.error("[skill-manager] failed to create watcher:", err.message);
    }
    this._watchExternalPaths();
  }

  async _autoReload() {
    const deps = this._reloadDeps;
    if (!deps) return;
    try {
      await this.reload(deps.resourceLoader, deps.agents);
      deps.onReloaded?.();
    } catch (err) {
      console.warn("[skill-manager] auto-reload failed:", err.message);
    }
  }

 /** 停止文件监听 */
  unwatch() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    this._reloadDeps = null;
    this._closeExternalWatchers();
  }

  /**
 * 更新外部路径，重新扫描外-skill，重-watcher
    *
   */
  setExternalPaths(paths) {
    this._externalPaths = paths;
    this._appendExternalSkills();
    this._closeExternalWatchers();
    if (this._reloadDeps) {
      this._watchExternalPaths();
    }
  }

 //

  /**
  * */
  scanExternalSkills() {
    const results = [];
    for (const { dirPath, label, scope } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(dirPath, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const meta = parseSkillMetadata(content, entry.name);
            const owner = scope === "workspace"
              ? "workspace"
              : (label.startsWith("plugin:") ? "plugin" : "external");
            const readonly = owner !== "workspace";
            const baseDir = path.join(dirPath, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              displayName: meta.displayName,
              displayNames: meta.displayNames,
              shortDescription: meta.shortDescription,
              shortDescriptions: meta.shortDescriptions,
              filePath: skillFile,
              baseDir,
              source: "external",
              disableModelInvocation: meta.disableModelInvocation,
              defaultEnabled: meta.defaultEnabled,
              _agentId: null,
              _hidden: false,
              _externalLabel: label,
              _externalPath: dirPath,
              _readonly: readonly,
              _pluginSkill: label.startsWith("plugin:"),
              _workspaceSkill: scope === "workspace",
              _managedBy: scope === "workspace" ? "workspace" : null,
              sourceIdentity: sourceIdentityForSkill({
                name: meta.name,
                filePath: skillFile,
                baseDir,
                source: "external",
                _pluginSkill: label.startsWith("plugin:"),
                _workspaceSkill: scope === "workspace",
                _externalLabel: label,
              }, { owner }),
            });
          } catch {}
        }
      } catch {}
    }
    return results;
  }

 /** 将外部技能追加到 _allSkills（去重：内部优先，先清理-external 再重扫） */
  _appendExternalSkills() {
    this._allSkills = this._allSkills.filter(s => s.source !== "external");
    const existingNames = new Set(this._allSkills.map(s => s.name));
    for (const ext of this.scanExternalSkills()) {
      if (!existingNames.has(ext.name)) {
        this._allSkills.push(ext);
        existingNames.add(ext.name);
      }
    }
  }

 //

  _watchExternalPaths() {
    for (const { dirPath } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      if (this._externalWatchers.has(dirPath)) continue;
      try {
        const w = chokidar.watch(dirPath, {
          ignoreInitial: true,
          ignored: createSkillWatchIgnore(dirPath),
          depth: SKILL_WATCH_DEPTH,
          persistent: true,
        });
        w.on("all", () => {
          if (this._reloadTimer) clearTimeout(this._reloadTimer);
          this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
        });
        w.on("error", (err) => {
          console.error(`[skill-manager] external watcher error (${dirPath}):`, err.message);
        });
        this._externalWatchers.set(dirPath, w);
      } catch (err) {
        console.error(`[skill-manager] failed to watch external path (${dirPath}):`, err.message);
      }
    }
  }

  _closeExternalWatchers() {
    for (const [, w] of this._externalWatchers) {
      try { w.close(); } catch {}
    }
    this._externalWatchers.clear();
  }

  _isRuntimeEnabledForAgent(skill, enabledSet) {
    return !!(
      skill?._pluginSkill
      || skill?._workspaceSkill
      || enabledSet?.has(skill.name)
    );
  }

  //

  /**
 * 扫描 agentDir/learned-skills/ 下的自学 skills
   * @param {string} agentDir
   */
  scanLearnedSkills(agentDir) {
    const agentId = path.basename(agentDir);
    const learnedDir = path.join(agentDir, "learned-skills");
    if (!fs.existsSync(learnedDir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(learnedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(learnedDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, "utf-8");
        const meta = parseSkillMetadata(content, entry.name);
        results.push({
          name: meta.name,
          description: meta.description,
          displayName: meta.displayName,
          displayNames: meta.displayNames,
          shortDescription: meta.shortDescription,
          shortDescriptions: meta.shortDescriptions,
          filePath: skillFile,
          baseDir: path.join(learnedDir, entry.name),
          source: "learned",
          disableModelInvocation: meta.disableModelInvocation,
          defaultEnabled: meta.defaultEnabled,
          _agentId: agentId,
          _hidden: false,
        });
      } catch {}
    }
    return results;
  }
}
