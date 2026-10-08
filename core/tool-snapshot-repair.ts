import { CORE_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";

export function repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, {
  coreToolNames = CORE_TOOL_NAMES,
} = {}) {
  const available = new Set(uniqueToolNames(allToolNames));
  const toolNames = [];
  const droppedToolNames = [];
  const seen = new Set();

  for (const name of uniqueToolNames(snapshotToolNames)) {
    if (seen.has(name)) continue;
    if (!available.has(name)) {
      seen.add(name);
      droppedToolNames.push(name);
      continue;
    }
    seen.add(name);
    toolNames.push(name);
  }

  for (const name of coreToolNames) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    toolNames.push(name);
  }

  return { toolNames, droppedToolNames };
}

export function repairRestoredToolSnapshot(snapshotToolNames, allToolNames, options = {}) {
  return repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, options).toolNames;
}

export function sameToolNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}
