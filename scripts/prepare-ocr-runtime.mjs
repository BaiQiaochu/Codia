#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor", "ocr-runtime");
const modelsRoot = path.join(vendorRoot, "models");
const ortRoot = path.join(vendorRoot, "ort");
const onnxRuntimeDist = path.join(root, "node_modules", "onnxruntime-web", "dist");

const MODEL_ASSETS = [
  {
    name: "PP-OCRv5_mobile_det.tar",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx.tar",
  },
  {
    name: "PP-OCRv5_mobile_rec.tar",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx.tar",
  },
];

const ORT_ASSET_RE = /^ort-wasm.*\.(wasm|mjs)$/;

async function main() {
  fs.mkdirSync(modelsRoot, { recursive: true });
  fs.mkdirSync(ortRoot, { recursive: true });

  for (const asset of MODEL_ASSETS) {
    await ensureDownloaded(path.join(modelsRoot, asset.name), asset.url);
  }
  copyOrtAssets();
  console.log(`[prepare-ocr-runtime] ready at ${vendorRoot}`);
}

async function ensureDownloaded(target, url) {
  if (isUsableFile(target)) {
    console.log(`[prepare-ocr-runtime] kept ${path.relative(root, target)}`);
    return;
  }

  const tempTarget = `${target}.download`;
  fs.rmSync(tempTarget, { force: true });
  console.log(`[prepare-ocr-runtime] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download OCR model ${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempTarget));
  const stat = fs.statSync(tempTarget);
  if (stat.size < 1024 * 1024) {
    fs.rmSync(tempTarget, { force: true });
    throw new Error(`downloaded OCR model is unexpectedly small: ${target}`);
  }
  fs.renameSync(tempTarget, target);
}

function copyOrtAssets() {
  if (!fs.existsSync(onnxRuntimeDist)) {
    throw new Error(`onnxruntime-web dist not found: ${onnxRuntimeDist}`);
  }

  let copied = 0;
  for (const entry of fs.readdirSync(onnxRuntimeDist, { withFileTypes: true })) {
    if (!entry.isFile() || !ORT_ASSET_RE.test(entry.name)) continue;
    const from = path.join(onnxRuntimeDist, entry.name);
    const to = path.join(ortRoot, entry.name);
    if (isSameSizeFile(from, to)) continue;
    fs.copyFileSync(from, to);
    copied += 1;
  }
  if (copied > 0) {
    console.log(`[prepare-ocr-runtime] copied ${copied} ONNX Runtime assets`);
  }
}

function isUsableFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function isSameSizeFile(from, to) {
  try {
    return fs.statSync(from).size === fs.statSync(to).size;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`[prepare-ocr-runtime] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
