// @ts-nocheck
/**
  *
  *
  * */

import path from "path";
import { materializeExecutorIdentity } from "../lib/subagent-executor-metadata.ts";
import { buildAutomationSuggestionBlock } from "./suggestion-blocks.ts";

export const BLOCK_EXTRACTORS = {
  // COMPAT(v0.98): present_files is a legacy alias for stage_files.
  stage_files: (details) => {
    const files = details.files || [];
    if (!files.length && details.filePath) {
      files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
    }
    return files.map(f => ({
      type: "file",
      ...sessionFileFields(f),
      filePath: f.filePath,
      label: f.label,
      ext: f.ext || "",
    }));
  },

  create_artifact: (details) => {
    if (!details.content) return null;
    const artifactFile = details.artifactFile || details.sessionFile || details.file || details;
    return [{
      type: "artifact",
      artifactId: details.artifactId,
      artifactType: details.type,
      title: details.title,
      content: details.content,
      language: details.language,
      ...sessionFileFields(artifactFile),
    }];
  },

  show_card: (details) => {
    if (!details?.code) return null;
    return [{
      type: "interactive_card",
      cardId: details.cardId || "",
      title: details.title || "",
      code: details.code,
    }];
  },

  browser: (details, toolResult) => {
    if (details.action !== "screenshot") return null;
    const screenshotFile = details.screenshotFile || (details.fileId || details.id ? details : null);
    if (screenshotFile) {
      return [{
        type: "file",
        ...sessionFileFields(screenshotFile),
        filePath: screenshotFile.filePath,
        label: screenshotFile.label || screenshotFile.displayName || screenshotFile.filename || "browser screenshot",
        ext: screenshotFile.ext || "png",
      }];
    }
    const imgBlock = toolResult?.content?.find(c => c.type === "image");
    const data = imgBlock?.data || details.thumbnail;
    if (!data) return null;
    return [{
      type: "screenshot",
      base64: data,
      mimeType: imgBlock?.mimeType || details.mimeType || "image/jpeg",
    }];
  },

  "media_generate-image": (details) => extractMediaGenerationBlocks(details, "image"),

  "media_generate-video": (details) => extractMediaGenerationBlocks(details, "video"),

  "image-gen_generate-image": (details) => extractMediaGenerationBlocks(details, "image"),

  "image-gen_generate-video": (details) => extractMediaGenerationBlocks(details, "video"),

  computer: (details) => {
    const confirmation = details.confirmation;
    if (details.action !== "start" || confirmation?.kind !== "computer_app_approval") return null;
    const block = buildComputerAppApprovalBlock(confirmation);
    return block ? [block] : null;
  },

  install_skill: (details) => {
    if (!details.skillName) return null;
    const installedFile = details.installedFile || null;
    return [{
      type: "skill",
      skillName: details.skillName,
      skillFilePath: details.skillFilePath || "",
      ...(details.installedSkillSource ? { installedSkillSource: details.installedSkillSource } : {}),
      ...(installedFile?.fileId || installedFile?.id ? { fileId: installedFile.fileId || installedFile.id } : {}),
      ...(installedFile ? { installedFile } : {}),
    }];
  },

  cron: (details) => {
    let jobData = details.jobData;
    if (!jobData && details.job) {
 //
      const j = details.job;
      jobData = { type: j.type, schedule: j.schedule, prompt: j.prompt, label: j.label, model: j.model };
    }
    if (!jobData) return null;
    const status = details.action === "pending_add"
      ? "pending"
      : details.confirmed === false
      ? "rejected"
      : (details.action === "cancelled" ? "rejected" : "approved");
    return [buildAutomationSuggestionBlock({ confirmId: details.confirmId || "", jobData, status })];
  },

  automation: (details) => {
    if (!["pending_add", "pending_update"].includes(details.action) || !details.jobData) return null;
    return [buildAutomationSuggestionBlock({
      confirmId: details.confirmId || "",
      jobData: details.jobData,
      operation: details.operation === "update" ? "update" : "create",
      status: "pending",
    })];
  },

  subagent: (details) => {
    if (!details.taskId) return null;
    const executor = materializeExecutorIdentity(details);
    const requestedAgentId = details.requestedAgentId || details.agentId || null;
    const requestedAgentName = details.requestedAgentNameSnapshot || details.agentName || requestedAgentId || null;
    return [{
      type: "subagent",
      taskId: details.taskId,
      task: details.task || "",
      taskTitle: details.taskTitle || "",
      agentId: executor?.agentId || null,
      agentName: executor?.agentName || null,
      requestedAgentId,
      requestedAgentName,
      executorAgentId: details.executorAgentId || executor?.agentId || null,
      executorAgentNameSnapshot: details.executorAgentNameSnapshot || executor?.agentName || null,
      streamKey: details.sessionPath || "",
      streamStatus: details.streamStatus || "running",
      summary: details.summary || null,
      threadId: details.threadId || null,
      threadKind: details.threadKind || null,
      label: details.label || details.reuseInstance || null,
      access: details.access || null,
      childSessionPath: details.childSessionPath || details.sessionPath || null,
    }];
  },

  workflow: (details) => {
    if (!details.taskId) return null;
    return [{
      type: "workflow",
      taskId: details.taskId,
      taskTitle: details.workflow || "",
      streamStatus: details.streamStatus || "running",
      summary: details.summary || null,
      startedAt: details.startedAt ?? null,
      finishedAt: details.finishedAt ?? null,
    }];
  },

  update_settings: (details) => {
    if (details.settingsUpdate) {
      return [{
        type: "settings_update",
        update: details.settingsUpdate,
      }];
    }
    if (!details.settingKey) return null;
    const status = details.confirmed === "timeout"
      ? "timeout"
      : (details.confirmed === false ? "rejected" : "confirmed");
    return [{
      type: "settings_confirm",
      confirmId: "",
      settingKey: details.settingKey,
      cardType: details.cardType || "list",
      currentValue: details.currentValue || "",
      proposedValue: details.proposedValue || "",
      label: details.label || details.settingKey,
      status,
    }];
  },
};

BLOCK_EXTRACTORS.present_files = BLOCK_EXTRACTORS.stage_files; // COMPAT(v0.98)

function buildComputerAppApprovalBlock(confirmation) {
  const approval = confirmation?.approval;
  if (!approval?.providerId || !approval?.appId) return null;
  const appName = approval.appName || approval.appId;
  return {
    type: "session_confirmation",
    confirmId: confirmation.confirmId || "",
    kind: "computer_app_approval",
    surface: "input",
    status: confirmation.status || "pending",
    title: "允许应用使用电脑",
    body: "应用需要控制此程序以继续当前任务。",
    subject: {
      label: appName,
      detail: `${approval.providerId} / ${approval.appId}`,
    },
    severity: "elevated",
    actions: {
      confirmLabel: "同意",
      rejectLabel: "拒绝",
    },
    payload: { approval },
  };
}

function sessionFileFields(file) {
  if (!file || typeof file !== "object") return {};
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

function extractMediaGenerationBlocks(details, fallbackKind) {
  const media = details?.mediaGeneration;
  if (!media || typeof media !== "object") return null;
  const tasks = Array.isArray(media.tasks) ? media.tasks : [];
  const kind = media.kind || fallbackKind || "image";
  const blocks = tasks
    .map((task) => {
      const taskId = typeof task === "string" ? task : task?.taskId;
      if (!taskId) return null;
      return {
        type: "media_generation",
        taskId,
        kind,
        ...(media.batchId ? { batchId: media.batchId } : {}),
        ...(media.prompt ? { prompt: media.prompt } : {}),
        status: "pending",
      };
    })
    .filter(Boolean);
  return blocks.length ? blocks : null;
}

function resultSessionFileBlocks(result, taskId, block) {
  const mediaFiles = collectMediaResultFiles(result);
  return mediaFiles
    .map((file) => sessionFileToContentBlock(file, {
      replacesTaskId: taskId,
      ...(block?.afterIndex !== undefined ? { afterIndex: block.afterIndex } : {}),
      ...(block?.sourceIndex !== undefined ? { sourceIndex: block.sourceIndex } : {}),
    }))
    .filter(Boolean);
}

function collectMediaResultFiles(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.sessionFiles) && result.sessionFiles.length > 0) return result.sessionFiles;
  if (Array.isArray(result.files) && result.files.length > 0) return result.files;
  if (result.result && typeof result.result === "object") return collectMediaResultFiles(result.result);
  return [];
}

function sessionFileToContentBlock(file, extra = undefined) {
  if (typeof file === "string") {
    const filePath = file.trim();
    if (!filePath) return null;
    const label = path.basename(filePath);
    const ext = path.extname(label || filePath).toLowerCase().replace(/^\./, "");
    return {
      type: "file",
      ...(extra || {}),
      filePath,
      label: label || filePath,
      ext,
    };
  }
  if (!file || typeof file !== "object") return null;
  const filePath = file.filePath || file.realPath || null;
  if (!filePath) return null;
  const fileId = file.fileId || file.id || null;
  const label = file.label || file.displayName || file.filename || path.basename(filePath);
  const ext = file.ext ?? path.extname(filePath || label).toLowerCase().replace(/^\./, "");
  return {
    type: "file",
    ...(extra || {}),
    ...(fileId ? { fileId } : {}),
    filePath,
    label,
    ext,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

function mediaGenerationFallbackBlock(block, result) {
  const status = result?.status === "aborted" ? "aborted" : "failed";
  return {
    ...block,
    status,
    ...(result?.reason ? { reason: result.reason } : {}),
  };
}

function mediaGenerationReplacementBlocks(block, result) {
  if (!result) return [block];
  if (result.status === "success" || result.status === "resolved") {
    const fileBlocks = resultSessionFileBlocks(result.result, block.taskId, block);
    return fileBlocks.length ? fileBlocks : [mediaGenerationFallbackBlock(block, {
      status: "failed",
      reason: "Generated result did not include a displayable file",
    })];
  }
  if (result.status === "failed" || result.status === "aborted") {
    return [mediaGenerationFallbackBlock(block, result)];
  }
  return [block];
}

function fileBlockKey(block) {
  if (!block || block.type !== "file") return null;
  return block.fileId || block.filePath || null;
}

function pushUniqueBlock(target, seenFiles, block) {
  const key = fileBlockKey(block);
  if (key) {
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
  }
  target.push(block);
}

function mediaKindFromDeferredType(type) {
  if (type === "video-generation") return "video";
  if (type === "image-generation") return "image";
  if (type === "audio-generation") return "audio";
  return "image";
}

export function mediaResultFromDeferredTask(taskId, task) {
  if (!taskId || !task || typeof task !== "object") return null;
  const status = task.status === "resolved" ? "success" : task.status;
  if (status !== "success" && status !== "failed" && status !== "aborted") return null;
  const type = typeof task.meta?.type === "string" ? task.meta.type : "image-generation";
  return {
    taskId,
    type,
    status,
    result: task.result ?? null,
    reason: task.reason || null,
  };
}

export function resolveMediaGenerationBlocksWithDeferredResults(blocks, deferredResults) {
  if (!Array.isArray(blocks) || blocks.length === 0) return Array.isArray(blocks) ? blocks : [];
  if (!deferredResults || typeof deferredResults.query !== "function") return blocks;

  const results = new Map();
  const sessionPathByTaskId = new Map();
  for (const block of blocks) {
    if (block?.type !== "media_generation" || !block.taskId) continue;
    if (typeof block.sessionPath === "string" && block.sessionPath) {
      sessionPathByTaskId.set(block.taskId, block.sessionPath);
    }
    const mediaResult = mediaResultFromDeferredTask(block.taskId, deferredResults.query(block.taskId));
    if (mediaResult) results.set(block.taskId, mediaResult);
  }
  if (results.size === 0) return blocks;

  return resolveMediaGenerationBlocks(blocks, results)
    .map((block) => {
      if (block?.type !== "file" || !block.replacesTaskId || block.sessionPath) return block;
      const sessionPath = sessionPathByTaskId.get(block.replacesTaskId);
      return sessionPath ? { ...block, sessionPath } : block;
    });
}

export function resolveMediaGenerationBlocks(blocks, results = new Map(), standaloneResults = []) {
  const resolved = [];
  const consumedTaskIds = new Set();
  const seenFiles = new Set();
  const resultMap = results && typeof results.get === "function" ? results : new Map();
  const mediaInterludesByTask = new Map();
  const emittedInterludeIds = new Set();

  for (const block of blocks || []) {
    if (block?.type !== "interlude" || !block.taskId || !resultMap.has(block.taskId)) continue;
    if (!mediaInterludesByTask.has(block.taskId)) mediaInterludesByTask.set(block.taskId, []);
    mediaInterludesByTask.get(block.taskId).push(block);
  }

  const pushInterludesForTask = (taskId) => {
    const interludes = mediaInterludesByTask.get(taskId) || [];
    for (const interlude of interludes) {
      const key = interlude.id || `${interlude.taskId}:${interlude.status || ""}:${interlude.text || ""}`;
      if (emittedInterludeIds.has(key)) continue;
      emittedInterludeIds.add(key);
      resolved.push(interlude);
    }
  };

  for (const block of blocks || []) {
    if (block?.type === "interlude" && block.taskId && resultMap.has(block.taskId)) {
      continue;
    }
    if (block?.type === "media_generation" && block.taskId && resultMap.has(block.taskId)) {
      const result = resultMap.get(block.taskId);
      consumedTaskIds.add(block.taskId);
      pushInterludesForTask(block.taskId);
      for (const replacement of mediaGenerationReplacementBlocks(block, result)) {
        pushUniqueBlock(resolved, seenFiles, replacement);
      }
      continue;
    }
    pushUniqueBlock(resolved, seenFiles, block);
  }

  for (const result of standaloneResults || []) {
    if (!result?.taskId || consumedTaskIds.has(result.taskId)) continue;
    const syntheticBlock = {
      type: "media_generation",
      taskId: result.taskId,
      kind: mediaKindFromDeferredType(result.type),
      status: "pending",
      ...(result.afterIndex !== undefined ? { afterIndex: result.afterIndex } : {}),
      ...(result.sourceIndex !== undefined ? { sourceIndex: result.sourceIndex } : {}),
    };
    pushInterludesForTask(result.taskId);
    for (const replacement of mediaGenerationReplacementBlocks(syntheticBlock, result)) {
      pushUniqueBlock(resolved, seenFiles, replacement);
    }
  }

  for (const taskId of mediaInterludesByTask.keys()) {
    pushInterludesForTask(taskId);
  }

  return resolved;
}

function extractPluginCard(details) {
  if (!details?.card?.pluginId) return null;
  const c = details.card;
  const {
    file: _file,
    files: _files,
    sessionFile: _sessionFile,
    sourceFile: _sourceFile,
    ...safeCard
  } = c;
  return { type: "plugin_card", card: { ...safeCard, type: safeCard.type || "iframe" } };
}

function shouldExtractPluginCard(toolName, details) {
  const card = details?.card;
  if (card?.pluginId === "image-gen" && String(toolName || "").startsWith("image-gen_")) {
    return false;
  }
  return true;
}

export function extractBlocks(toolName, details, toolResult) {
  const blocks = [];
  const extractor = BLOCK_EXTRACTORS[toolName];
  if (extractor) {
    const result = extractor(details || {}, toolResult);
    if (result) blocks.push(...result);
  }
  const card = shouldExtractPluginCard(toolName, details) ? extractPluginCard(details) : null;
  if (card) blocks.push(card);
  return blocks;
}
