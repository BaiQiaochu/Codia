/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const JIMENG_INSTALL_COMMAND = "curl -s https://jimeng.jianying.com/cli | bash";

const IMAGE_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
const IMAGE_RATIOS_SET = new Set(IMAGE_RATIOS);
const VIDEO_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];
const VIDEO_RATIOS_SET = new Set(VIDEO_RATIOS);
const DEFAULT_VIDEO_RATIO = "16:9";
const DEFAULT_VIDEO_DURATION = 5;
const DEFAULT_VIDEO_RESOLUTION = "720p";
const RESULT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm"]);
const PENDING_STATUSES = new Set(["querying", "pending", "running", "processing", "submitted"]);
const SUCCESS_STATUSES = new Set(["success", "succeeded", "done", "completed"]);
const FAILED_STATUSES = new Set(["fail", "failed", "error"]);
const TEXT_TO_VIDEO_MODELS = new Set(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip"]);
const IMAGE_TO_VIDEO_MODELS = new Set([
  "3.0",
  "3.0fast",
  "3.0pro",
  "3.0_fast",
  "3.0_pro",
  "3.5pro",
  "3.5_pro",
  "seedance2.0",
  "seedance2.0fast",
  "seedance2.0_vip",
  "seedance2.0fast_vip",
]);

function executableName(platform = process.platform) {
  return platform === "win32" ? "dreamina.exe" : "dreamina";
}

function pathEntries(envPath = "") {
  return String(envPath || "").split(path.delimiter).filter(Boolean);
}

function defaultWhich(command, envPath = process.env.PATH || "", exists = fs.existsSync) {
  for (const dir of pathEntries(envPath)) {
    const candidate = path.join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveDreaminaCommand({
  env = process.env,
  exists = fs.existsSync,
  which = (command, searchPath) => defaultWhich(command, searchPath, exists),
  homeDir = os.homedir(),
  platform = process.platform,
}: any = {}) {
  const explicit = typeof env.DREAMINA_CLI_PATH === "string" ? env.DREAMINA_CLI_PATH.trim() : "";
  if (explicit && exists(explicit)) return explicit;

  const command = executableName(platform);
  const fromPath = which(command, env.PATH || "");
  if (fromPath) return fromPath;

  const installDirs = [
    env.DREAMINA_INSTALL_DIR,
    env.DREAMINA_CLI_INSTALL_DIR,
    platform === "win32" ? path.join(homeDir, "bin") : path.join(homeDir, ".local", "bin"),
  ].filter((value) => typeof value === "string" && value.trim());
  for (const dir of installDirs) {
    const candidate = path.join(String(dir), command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

async function defaultRunCommand(command, args, options: any = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    shell: false,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function firstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Some CLI commands print notes before JSON; try extracting the outer object.
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringFromKeys(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return "";
}

function statusFromRaw(value) {
  const status = String(value || "").trim().toLowerCase();
  if (SUCCESS_STATUSES.has(status)) return "success";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (PENDING_STATUSES.has(status)) return "querying";
  return status || "";
}

export function parseDreaminaTaskOutput(stdout) {
  const text = String(stdout || "");
  const json = firstJsonObject(text);
  const submitId = stringFromKeys(json, ["submit_id", "submitId", "id"])
    || text.match(/submit_id\s*[:=]\s*([^\s]+)/i)?.[1]
    || "";
  const rawStatus = stringFromKeys(json, ["gen_status", "genStatus", "status", "task_status"])
    || text.match(/gen_status\s*[:=]\s*([^\s]+)/i)?.[1]
    || text.match(/task_status\s*[:=]\s*([^\s]+)/i)?.[1]
    || "";
  const failReason = stringFromKeys(json, ["fail_reason", "failReason", "error_msg", "error", "message"])
    || text.match(/fail_reason\s*[:=]\s*(.+)$/im)?.[1]?.trim()
    || null;
  return {
    submitId,
    status: statusFromRaw(rawStatus),
    failReason,
  };
}

function ensureCommand(resolveCommand) {
  const command = resolveCommand();
  if (!command) {
    const err: any = new Error(`Dreamina CLI was not found. Install it first: ${JIMENG_INSTALL_COMMAND}`);
    err.code = "cli_missing";
    err.installCommand = JIMENG_INSTALL_COMMAND;
    throw err;
  }
  return command;
}

function commandOptions(extra: any = {}) {
  return {
    ...extra,
    shell: false,
    timeout: extra.timeout || 120_000,
  };
}

function imagesFromParams(params: any = {}) {
  const input = params.referenceImages || params.images || params.image;
  if (!input) return [];
  return (Array.isArray(input) ? input : [input])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function appendStringArg(args, option, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(option, String(value));
}

function normalizeImageModelVersion(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  return raw.replace(/^jimeng-image-/i, "");
}

function normalizeVideoModelVersion(model) {
  return String(model || "").trim();
}

function imageResolution(params: any = {}, defaults: any = {}) {
  return params.resolution_type || params.resolutionType || params.resolution || defaults.resolution_type || defaults.resolution;
}

function supportedImageResolutions(modelVersion) {
  const version = String(modelVersion || "").trim();
  if (/^(3\.0|3\.1)$/.test(version)) return ["1k", "2k"];
  return ["2k", "4k"];
}

function normalizeImageResolution(value) {
  if (!value) return "";
  const match = String(value).trim().toLowerCase().match(/^([124])\s*k$/);
  return match ? `${match[1]}k` : String(value).trim();
}

function resolveImageResolution(params: any = {}, defaults: any = {}, modelVersion = "") {
  const supported = supportedImageResolutions(modelVersion);
  const raw = imageResolution(params, defaults) || supported[supported.length - 1];
  const resolution = normalizeImageResolution(raw);
  if (!supported.includes(resolution)) {
    throw new Error(`Jimeng image resolution "${raw}" is unsupported for model "${modelVersion}"; supported resolutions: ${supported.join(", ")}`);
  }
  return resolution;
}

function resolveImageRatio(params: any = {}, defaults: any = {}) {
  const ratio = params.ratio || params.aspect_ratio || params.aspectRatio || defaults.ratio || "3:2";
  if (!IMAGE_RATIOS_SET.has(ratio)) {
    throw new Error(`Jimeng image ratio "${ratio}" is unsupported`);
  }
  return ratio;
}

function videoResolution(params: any = {}, defaults: any = {}) {
  return params.video_resolution || params.videoResolution || params.resolution || defaults.video_resolution || defaults.videoResolution || defaults.resolution;
}

function supportedVideoResolutions(modelVersion) {
  return modelVersion === "seedance2.0_vip" ? ["720p", "1080p"] : ["720p"];
}

function normalizeVideoResolution(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveVideoResolution(params: any = {}, defaults: any = {}, modelVersion = "") {
  const supported = supportedVideoResolutions(modelVersion);
  const raw = videoResolution(params, defaults) || DEFAULT_VIDEO_RESOLUTION;
  const resolution = normalizeVideoResolution(raw);
  if (!supported.includes(resolution)) {
    throw new Error(`Dreamina video resolution "${raw}" is unsupported for model "${modelVersion}"; supported resolutions: ${supported.join(", ")}`);
  }
  return resolution;
}

function videoDurationRange(modelVersion) {
  const normalized = String(modelVersion || "").replace(/_/g, "");
  if (/^3\.0/.test(normalized)) return { min: 3, max: 10 };
  if (normalized === "3.5pro") return { min: 4, max: 12 };
  return { min: 4, max: 15 };
}

function resolveVideoDuration(params: any = {}, defaults: any = {}, modelVersion = "") {
  const raw = params.duration ?? params.seconds ?? defaults.duration ?? defaults.seconds ?? DEFAULT_VIDEO_DURATION;
  const duration = Number(raw);
  const range = videoDurationRange(modelVersion);
  if (!Number.isInteger(duration) || duration < range.min || duration > range.max) {
    throw new Error(`Dreamina video duration "${raw}" is unsupported for model "${modelVersion}"; supported range: ${range.min}-${range.max}s`);
  }
  return duration;
}

function resolveVideoRatio(params: any = {}, defaults: any = {}) {
  const ratio = params.ratio || params.aspect_ratio || params.aspectRatio || defaults.ratio || DEFAULT_VIDEO_RATIO;
  if (!VIDEO_RATIOS_SET.has(ratio)) {
    throw new Error(`Dreamina video ratio "${ratio}" is unsupported; supported ratios: ${VIDEO_RATIOS.join(", ")}`);
  }
  return ratio;
}

function imageProviderDefaults(ctx: any = {}, providerId = "jimeng-cli") {
  const all = ctx.config?.get?.("providerDefaults") ?? {};
  return all?.[providerId] || {};
}

function videoProviderDefaults(ctx: any = {}, providerId = "jimeng-cli") {
  const all = ctx.videoConfig?.get?.("providerDefaults") ?? ctx.config?.get?.("providerDefaults") ?? {};
  return all?.[providerId] || {};
}

function assertSubmitAccepted(parsed) {
  if (!parsed.submitId) {
    throw new Error("Dreamina CLI did not return submit_id");
  }
  if (parsed.status === "failed") {
    throw new Error(parsed.failReason || "Dreamina generation failed");
  }
  return { taskId: parsed.submitId };
}

function listResultFiles(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((name) => RESULT_EXTS.has(path.extname(name).toLowerCase()))
    .sort();
}

function relativeExistingFiles(files, outputDir) {
  const result = [];
  for (const file of files || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const fullPath = path.isAbsolute(file) ? file : path.join(outputDir, file);
    if (!fs.existsSync(fullPath)) continue;
    result.push(path.relative(outputDir, fullPath));
  }
  return result;
}

function outputFilesFromJson(stdout, outputDir) {
  const json = firstJsonObject(stdout);
  if (!json || typeof json !== "object") return [];
  const candidates = [];
  for (const key of ["files", "file_paths", "downloaded_files", "download_paths", "local_paths"]) {
    if (Array.isArray(json[key])) candidates.push(...json[key]);
  }
  for (const key of ["file", "file_path", "downloaded_file", "download_path", "local_path"]) {
    if (typeof json[key] === "string") candidates.push(json[key]);
  }
  return relativeExistingFiles(candidates, outputDir);
}

function queryStatus(parsed) {
  if (parsed.status === "success") return "success";
  if (parsed.status === "failed") return "failed";
  return "pending";
}

function createAuthFailure(code, message) {
  return {
    ok: false,
    code,
    ...(code === "cli_missing" ? { installCommand: JIMENG_INSTALL_COMMAND } : {}),
    message,
  };
}

function createJimengAdapter({
  id,
  name,
  protocolId,
  type,
  capabilities,
  buildSubmitArgs,
  resolveCommand = () => resolveDreaminaCommand(),
  runCommand = defaultRunCommand,
}: any) {
  return {
    id,
    protocolId,
    name,
    types: [type],
    capabilities,

    async checkAuth(_ctx: any = {}) {
      const command = resolveCommand();
      if (!command) {
        return createAuthFailure("cli_missing", `Dreamina CLI was not found. Install it first: ${JIMENG_INSTALL_COMMAND}`);
      }
      try {
        await runCommand(command, ["user_credit"], commandOptions({ timeout: 30_000 }));
        return { ok: true };
      } catch (err: any) {
        const output = `${err?.stdout || ""}\n${err?.stderr || ""}\n${err?.message || ""}`;
        if (/not\s+logged|login|required|未检测到有效登录|尚未登录/i.test(output)) {
          return createAuthFailure("login_required", "Dreamina CLI is not logged in. Run `dreamina login` first.");
        }
        return createAuthFailure("cli_unavailable", err?.message || String(err));
      }
    },

    async submit(params: any = {}, ctx: any = {}) {
      const command = ensureCommand(resolveCommand);
      const args = buildSubmitArgs(params, ctx);
      const { stdout } = await runCommand(command, args, commandOptions({
        cwd: ctx.generatedDir || ctx.dataDir,
        timeout: 120_000,
      }));
      return assertSubmitAccepted(parseDreaminaTaskOutput(stdout));
    },

    async query(providerTaskId, ctx: any = {}) {
      const command = ensureCommand(resolveCommand);
      const outputDir = ctx.generatedDir || path.join(ctx.dataDir, "generated");
      fs.mkdirSync(outputDir, { recursive: true });
      const before = new Set(listResultFiles(outputDir));
      const { stdout } = await runCommand(command, [
        "query_result",
        "--submit_id",
        String(providerTaskId),
        "--download_dir",
        outputDir,
      ], commandOptions({
        cwd: outputDir,
        timeout: 120_000,
      }));
      const parsed = parseDreaminaTaskOutput(stdout);
      const status = queryStatus(parsed);
      if (status === "failed") {
        return {
          status: "failed",
          failReason: parsed.failReason || "Dreamina generation failed",
          error: { code: "DREAMINA_FAILED", message: parsed.failReason || "Dreamina generation failed" },
        };
      }
      if (status === "pending") return { status: "pending" };

      const filesFromJson = outputFilesFromJson(stdout, outputDir);
      const after = listResultFiles(outputDir);
      const downloaded = after.filter((name) => !before.has(name));
      const files = [...new Set([...filesFromJson, ...downloaded])];
      if (files.length === 0) {
        return {
          status: "failed",
          failReason: "Dreamina query succeeded but no media file was downloaded",
          error: {
            code: "DREAMINA_NO_FILE",
            message: "Dreamina query succeeded but no media file was downloaded",
          },
        };
      }
      return { status: "success", files };
    },
  };
}

function buildImageSubmitArgs(params: any = {}, ctx: any = {}) {
  const defaults = imageProviderDefaults(ctx, params.providerId || "jimeng-cli");
  const images = imagesFromParams(params);
  if (images.length > 10) throw new Error("Dreamina image2image supports at most 10 input images");
  const modelVersion = normalizeImageModelVersion(params.modelId || params.model || defaults.model || "jimeng-image-5.0");
  const args = [images.length > 0 ? "image2image" : "text2image"];
  if (images.length > 0) {
    for (const image of images) appendStringArg(args, "--images", image);
  }
  appendStringArg(args, "--prompt", params.prompt);
  appendStringArg(args, "--model_version", modelVersion);
  appendStringArg(args, "--ratio", resolveImageRatio(params, defaults));
  appendStringArg(args, "--resolution_type", resolveImageResolution(params, defaults, modelVersion));
  appendStringArg(args, "--poll", 0);
  return args;
}

function buildVideoSubmitArgs(params: any = {}, ctx: any = {}) {
  const defaults = videoProviderDefaults(ctx, params.providerId || "jimeng-cli");
  const images = imagesFromParams(params);
  const modelVersion = normalizeVideoModelVersion(params.modelId || params.model || defaults.model || "seedance2.0fast");
  const mode = params.mode || (images.length === 1 ? "image2video" : "text2video");
  if (mode === "text2video" && images.length !== 0) {
    throw new Error("Dreamina text2video does not accept reference images");
  }
  if (mode === "image2video" && images.length !== 1) {
    throw new Error("Dreamina image2video requires exactly one reference image");
  }
  if (mode !== "text2video" && mode !== "image2video") {
    throw new Error(`Dreamina video mode "${mode}" is not implemented by this adapter`);
  }
  if (images.length > 1) {
    throw new Error("Dreamina multi-reference video requires the native video input contract to pass mode-specific fields");
  }
  if (mode === "text2video" && !TEXT_TO_VIDEO_MODELS.has(modelVersion)) {
    throw new Error(`Dreamina model "${modelVersion}" does not support text2video`);
  }
  if (mode === "image2video" && !IMAGE_TO_VIDEO_MODELS.has(modelVersion)) {
    throw new Error(`Dreamina model "${modelVersion}" does not support image2video`);
  }
  const duration = resolveVideoDuration(params, defaults, modelVersion);
  const resolution = resolveVideoResolution(params, defaults, modelVersion);
  const args = [mode];
  if (images.length === 1) appendStringArg(args, "--image", images[0]);
  appendStringArg(args, "--prompt", params.prompt);
  appendStringArg(args, "--model_version", modelVersion);
  if (images.length === 0) {
    appendStringArg(args, "--ratio", resolveVideoRatio(params, defaults));
  }
  appendStringArg(args, "--duration", duration);
  appendStringArg(args, "--video_resolution", resolution);
  appendStringArg(args, "--poll", 0);
  return args;
}

export function createJimengImageAdapter(options: any = {}) {
  return createJimengAdapter({
    id: "jimeng-cli-images",
    protocolId: "jimeng-cli-images",
    name: "Jimeng CLI Images",
    type: "image",
    capabilities: {
      ratios: IMAGE_RATIOS,
      resolutions: ["2k", "4k"],
      referenceImages: { min: 0, max: 10 },
    },
    buildSubmitArgs: buildImageSubmitArgs,
    ...options,
  });
}

export function createJimengVideoAdapter(options: any = {}) {
  return createJimengAdapter({
    id: "jimeng-cli-videos",
    protocolId: "jimeng-cli-videos",
    name: "Jimeng CLI Videos",
    type: "video",
    capabilities: {
      ratios: VIDEO_RATIOS,
      resolutions: [DEFAULT_VIDEO_RESOLUTION],
      duration: { min: 4, max: 15 },
      referenceImages: { min: 0, max: 1 },
    },
    buildSubmitArgs: buildVideoSubmitArgs,
    ...options,
  });
}

export const jimengImageAdapter = createJimengImageAdapter();
export const jimengVideoAdapter = createJimengVideoAdapter();
