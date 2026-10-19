import fs from "fs";
import path from "path";
import { randomUUID, createHash } from "node:crypto";
import { openExperienceStore } from "../experience-store.ts";
import { deleteCacheSnapshotObservation } from "./cache-snapshot-observation.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const COMPILED_FILES = ["memory.md", "facts.md", "today.md", "week.md", "longterm.md", "editable-facts.md"];

export function resetMarkerPath(memoryDir) {
  return path.join(memoryDir, "reset.json");
}

export function readCompiledResetAt(memoryDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(resetMarkerPath(memoryDir), "utf-8"));
    const value = raw?.compiledResetAt;
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeCompiledResetMarker(memoryDir, resetAt = new Date().toISOString()) {
  if (!resetAt || Number.isNaN(Date.parse(resetAt))) {
    throw new Error("compiledResetAt must be an ISO timestamp");
  }
  fs.mkdirSync(memoryDir, { recursive: true });
  const marker = {
    compiledResetAt: resetAt,
    generation: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(resetMarkerPath(memoryDir), JSON.stringify(marker, null, 2) + "\n");
  return resetAt;
}

export function clearCompiledMemoryArtifacts(memoryDir) {
  if (path.basename(memoryDir) === "memory") deleteCacheSnapshotObservation(path.dirname(memoryDir));
  fs.mkdirSync(memoryDir, { recursive: true });
  removeIfExists(path.join(memoryDir, "editable-facts-state.json"));
  removeIfExists(path.join(memoryDir, "compiled-eligibility.json"));
  for (const name of COMPILED_FILES) {
    const filePath = path.join(memoryDir, name);
    fs.writeFileSync(filePath, "", "utf-8");
    removeIfExists(`${filePath}.fingerprint`);
  }
}

export function clearCompiledSummarySources(summariesDir, summaryManager = null) {
  fs.mkdirSync(summariesDir, { recursive: true });
  for (const entry of fs.readdirSync(summariesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    removeIfExists(path.join(summariesDir, entry.name));
  }
  summaryManager?.clearCache?.();
}

/** Snapshot token captured before async work; reset/correction invalidates it. */
export function readCompiledGeneration(memoryDir) {
  const read = (name, key) => {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(memoryDir, name), "utf8"));
      return marker[key] || marker.compiledResetAt || "0";
    } catch (error) {
      if (error?.code === "ENOENT") return "0";
      throw error;
    }
  };
  return `${read("lifecycle.json", "generation")}:${read("reset.json", "generation")}`;
}

export const getCompiledMemoryGeneration = readCompiledGeneration;

/** Destructive experience changes invalidate derived text, ordinary additions do not. */
function experienceGeneration(memoryDir) {
  const agentDir = path.basename(memoryDir) === "memory" ? path.dirname(memoryDir) : memoryDir;
  const store = openExperienceStore(agentDir);
  try { return String(store.revocationGeneration); } finally { store.close(); }
}
function readEligibility(memoryDir) {
  try { return JSON.parse(fs.readFileSync(path.join(memoryDir, "compiled-eligibility.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function fileHash(memoryDir, section) {
  try { return createHash("sha256").update(fs.readFileSync(path.join(memoryDir, section))).digest("hex"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function eligibleEpoch(memoryDir, state, now, currentExperience) {
  if (!state) return readCompiledGeneration(memoryDir) === "0:0" && currentExperience === "0";
  return state.generation === readCompiledGeneration(memoryDir)
    && String(state.experienceGeneration ?? "0") === currentExperience
    && (!state.expiresAt || (Number.isFinite(Date.parse(state.expiresAt)) && Date.parse(state.expiresAt) > Date.parse(now)));
}

/** Validate the exact artifact, so a newer facts compile cannot bless old summaries. */
export function isCompiledSectionEligible(memoryDir, section, now = new Date().toISOString()) {
  try {
    const state = readEligibility(memoryDir);
    const entry = state?.sections?.[section];
    if (entry) return eligibleEpoch(memoryDir, entry, now, experienceGeneration(memoryDir)) && entry.contentHash === fileHash(memoryDir, section);
    if (state?.sections) return !fs.existsSync(path.join(memoryDir, section)) || !fs.readFileSync(path.join(memoryDir, section), "utf8").trim();
    return eligibleEpoch(memoryDir, state, now, experienceGeneration(memoryDir));
  } catch { return false; }
}

/** Bind frozen consumers to memory.md itself, not whatever section was compiled last. */
export function isCompiledMemoryEligible(memoryDir, now = new Date().toISOString()) {
  try {
    const state = readEligibility(memoryDir);
    if (state?.sections?.["memory.md"]) return isCompiledSectionEligible(memoryDir, "memory.md", now);
    if (state?.sections) return Object.keys(state.sections).every(section => isCompiledSectionEligible(memoryDir, section, now));
    return eligibleEpoch(memoryDir, state, now, experienceGeneration(memoryDir));
  } catch { return false; }
}

/** Evidence attached to an adopted compiled section; only call after eligibility. */
export function readCompiledSectionEvidence(memoryDir, section) {
  const state = readEligibility(memoryDir);
  const entry = state?.sections?.[section] || state;
  return {
    lifecycleGeneration: readCompiledGeneration(memoryDir).split(":")[0],
    compiledGeneration: entry?.generation || readCompiledGeneration(memoryDir),
    experienceGeneration: String(entry?.experienceGeneration ?? "0"),
    capturedAt: new Date().toISOString(), expiresAt: entry?.expiresAt || null,
  };
}

export function writeCompiledEligibility(memoryDir, facts, opts: Record<string, any> = {}) {
  const expirationValues = facts.flatMap(fact => [fact.expiresAt, fact.validTo]);
  if (opts.epoch?.expiresAt) expirationValues.push(opts.epoch.expiresAt);
  const expiresAt = expirationValues.filter(Boolean).sort()[0] || null;
  const generation = readCompiledGeneration(memoryDir);
  const currentExperience = experienceGeneration(memoryDir);
  const entry = { generation, experienceGeneration: opts.epoch?.experienceGeneration ?? currentExperience, expiresAt };
  if (!opts.section) {
    atomicWrite(path.join(memoryDir, "compiled-eligibility.json"), JSON.stringify(entry) + "\n");
    return;
  }
  const previous = readEligibility(memoryDir);
  const sections = { ...(previous?.sections || {}) };
  // Snapshot pre-migration artifacts under their OLD epoch, never under this write's.
  if (!previous?.sections) for (const section of COMPILED_FILES) {
    const contentHash = fileHash(memoryDir, section);
    if (contentHash) sections[section] = {
      generation: previous?.generation || "0:0", experienceGeneration: previous?.experienceGeneration || "0",
      expiresAt: previous?.expiresAt || null, contentHash,
    };
  }
  sections[opts.section] = { ...entry, contentHash: fileHash(memoryDir, opts.section) };
  const futureExpiries = Object.values(sections).filter((item: any) => eligibleEpoch(memoryDir, item, new Date().toISOString(), currentExperience))
    .map((item: any) => item.expiresAt).filter(Boolean).sort();
  atomicWrite(path.join(memoryDir, "compiled-eligibility.json"), JSON.stringify({
    generation, experienceGeneration: currentExperience, expiresAt: futureExpiries[0] || null, sections,
  }) + "\n");
}

export function assertCompiledGeneration(memoryDir, expected) {
  if (readCompiledGeneration(memoryDir) !== expected) {
    const error = new Error("Memory generation changed; stale derived result discarded");
    Object.assign(error, { code: "MEMORY_GENERATION_CHANGED" });
    throw error;
  }
}

export function normalizeCompiledSectionBody(value) {
  const raw = stripThinkTagBlocks(String(value || "")).trim();
  if (!raw) return "";

  const parsedArray = parseStringArray(raw);
  const text = parsedArray
    ? parsedArray.map((item) => `- ${item.trim()}`).join("\n")
    : raw;

  return text
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s+\S/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCompiledLLMResult(value, source = "compiled memory") {
  const normalized = normalizeCompiledSectionBody(value);
  if (!normalized && hasDanglingLeadingThinkTag(value)) {
    throw new Error(`${source} returned an unterminated thinking block`);
  }
  return normalized;
}

export function stripThinkTagBlocks(value) {
  return String(value || "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/<\/think(?:ing)?>\s*/gi, "");
}

export function hasDanglingLeadingThinkTag(value) {
  const text = String(value || "");
  return /^\s*<think(?:ing)?>/i.test(text) && !/<\/think(?:ing)?>/i.test(text);
}

function parseStringArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    return parsed.filter((item) => item.trim());
  } catch {
    return null;
  }
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, content);
}
