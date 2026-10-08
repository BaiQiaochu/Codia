#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const ROOT = path.resolve(__dirname, "..");
const ICON_PATH = path.join(ROOT, "desktop", "src", "icon.png");
const ICON_ICO_PATH = path.join(ROOT, "desktop", "src", "icon.ico");
const ICON_ICNS_PATH = path.join(ROOT, "desktop", "src", "icon.icns");
const ASSETS_DIR = path.join(ROOT, "desktop", "src", "assets");
const SOURCE_PATH = path.join(ASSETS_DIR, "codia", "codia-brand-master.png");
const CHARACTER_ASSETS_DIR = path.join(ASSETS_DIR, "character-cards");
const ICON_SIZE = 512;
const SAFE_AREA_RATIO = 0.86;

function findVisibleBounds(source) {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (source.data[(y * source.width + x) * 4 + 3] < 24) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    throw new Error(`Codia source contains no visible artwork: ${SOURCE_PATH}`);
  }
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

function sampleArea(source, left, top, right, bottom) {
  let totalWeight = 0;
  let alphaWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
    if (y < 0 || y >= source.height) continue;
    const overlapY = Math.max(0, Math.min(bottom, y + 1) - Math.max(top, y));
    for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
      if (x < 0 || x >= source.width) continue;
      const overlapX = Math.max(0, Math.min(right, x + 1) - Math.max(left, x));
      const weight = overlapX * overlapY;
      if (weight <= 0) continue;

      const index = (y * source.width + x) * 4;
      const alpha = source.data[index + 3] / 255;
      const premultipliedWeight = weight * alpha;
      red += source.data[index] * premultipliedWeight;
      green += source.data[index + 1] * premultipliedWeight;
      blue += source.data[index + 2] * premultipliedWeight;
      alphaWeight += premultipliedWeight;
      totalWeight += weight;
    }
  }

  if (totalWeight === 0 || alphaWeight === 0) return [0, 0, 0, 0];
  return [
    Math.round(red / alphaWeight),
    Math.round(green / alphaWeight),
    Math.round(blue / alphaWeight),
    Math.round((alphaWeight / totalWeight) * 255),
  ];
}

function renderSquare(source, size) {
  const bounds = findVisibleBounds(source);
  const artworkWidth = bounds.right - bounds.left;
  const artworkHeight = bounds.bottom - bounds.top;
  const targetExtent = size * SAFE_AREA_RATIO;
  const scale = Math.min(targetExtent / artworkWidth, targetExtent / artworkHeight);
  const targetWidth = artworkWidth * scale;
  const targetHeight = artworkHeight * scale;
  const targetLeft = (size - targetWidth) / 2;
  const targetTop = (size - targetHeight) / 2;
  const output = new PNG({ width: size, height: size, colorType: 6 });

  for (let y = Math.floor(targetTop); y < Math.ceil(targetTop + targetHeight); y += 1) {
    for (let x = Math.floor(targetLeft); x < Math.ceil(targetLeft + targetWidth); x += 1) {
      const sourceLeft = bounds.left + ((x - targetLeft) / targetWidth) * artworkWidth;
      const sourceTop = bounds.top + ((y - targetTop) / targetHeight) * artworkHeight;
      const sourceRight = bounds.left + ((x + 1 - targetLeft) / targetWidth) * artworkWidth;
      const sourceBottom = bounds.top + ((y + 1 - targetTop) / targetHeight) * artworkHeight;
      const color = sampleArea(source, sourceLeft, sourceTop, sourceRight, sourceBottom);
      const index = (y * size + x) * 4;
      output.data.set(color, index);
    }
  }
  return output;
}

function resizeSquare(source, size) {
  const output = new PNG({ width: size, height: size, colorType: 6 });
  const scale = source.width / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = sampleArea(
        source,
        x * scale,
        y * scale,
        (x + 1) * scale,
        (y + 1) * scale,
      );
      output.data.set(color, (y * size + x) * 4);
    }
  }
  return output;
}

function writePng(filePath, png) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png, { colorType: 6 }));
}

function createIcns(layers) {
  const payloadLength = layers.reduce((sum, layer) => sum + 8 + layer.data.length, 0);
  const output = Buffer.alloc(8 + payloadLength);
  output.write("icns", 0, 4, "ascii");
  output.writeUInt32BE(output.length, 4);
  let offset = 8;
  for (const layer of layers) {
    output.write(layer.type, offset, 4, "ascii");
    output.writeUInt32BE(layer.data.length + 8, offset + 4);
    layer.data.copy(output, offset + 8);
    offset += layer.data.length + 8;
  }
  return output;
}

function main() {
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(`Codia brand source not found: ${SOURCE_PATH}`);
  }

  // Preserve the approved transparent artwork for UI, shell and packaging alike.
  const source = PNG.sync.read(fs.readFileSync(SOURCE_PATH));
  const icon = renderSquare(source, ICON_SIZE);
  const sharedPngTargets = [
    ICON_PATH,
    path.join(ASSETS_DIR, "codia", "codia-brand-emblem.png"),
    path.join(ASSETS_DIR, "G-SAP.png"),
    path.join(ASSETS_DIR, "about-icon.png"),
    path.join(CHARACTER_ASSETS_DIR, "gsap-default-avatar.png"),
    path.join(CHARACTER_ASSETS_DIR, "gsap-emblem.png"),
    path.join(CHARACTER_ASSETS_DIR, "butter-emblem.png"),
    path.join(CHARACTER_ASSETS_DIR, "ming-emblem.png"),
    path.join(CHARACTER_ASSETS_DIR, "kong-emblem.png"),
  ];
  for (const target of sharedPngTargets) writePng(target, icon);

  for (const [filename, size] of [
    ["tray-template.png", 16],
    ["tray-dev-template.png", 16],
    ["tray-template@2x.png", 32],
    ["tray-dev-template@2x.png", 32],
  ]) {
    writePng(path.join(ASSETS_DIR, filename), resizeSquare(icon, size));
  }

  const icnsLayers = [
    ["ic10", 1024],
    ["ic09", 512],
    ["ic08", 256],
    ["ic07", 128],
    ["icp6", 64],
    ["icp5", 32],
    ["icp4", 16],
  ].map(([type, size]) => ({
    type,
    data: PNG.sync.write(
      size === ICON_SIZE ? icon : resizeSquare(icon, size),
      { colorType: 6 },
    ),
  }));
  fs.writeFileSync(ICON_ICNS_PATH, createIcns(icnsLayers));

  childProcess.execFileSync(process.execPath, [path.join(__dirname, "generate-windows-icon.cjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  for (const target of [
    path.join(ROOT, "desktop", "src", "tray.ico"),
    path.join(ROOT, "desktop", "src", "tray-dev.ico"),
    path.join(ASSETS_DIR, "tray.ico"),
    path.join(ASSETS_DIR, "tray-dev.ico"),
  ]) {
    fs.copyFileSync(ICON_ICO_PATH, target);
  }

  console.log("Generated Codia icon assets from desktop/src/assets/codia/codia-brand-master.png.");
}

// Keep deterministic rendering reusable without rewriting checked-in assets on import.
module.exports = { renderSquare };
if (require.main === module) main();
