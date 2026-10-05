import fs from "fs";
import path from "path";

export const PLUGIN_FORMAT_INCOMPATIBLE_CODE = "PLUGIN_FORMAT_INCOMPATIBLE";

export function detectIncompatiblePluginFormat(pluginDir) {
  const openClawManifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (fs.existsSync(openClawManifestPath)) {
    const manifest = readJsonObject(openClawManifestPath);
    return createOpenClawIssue({
      marker: "openclaw.plugin.json",
      id: stringField(manifest?.id),
      name: stringField(manifest?.name),
      version: stringField(manifest?.version),
    });
  }

  const packageJson = readJsonObject(path.join(pluginDir, "package.json"));
  if (packageJson?.openclaw && !fs.existsSync(path.join(pluginDir, "manifest.json"))) {
    return createOpenClawIssue({
      marker: "package.json openclaw block",
      id: stringField(packageJson?.openclaw?.id) || stringField(packageJson?.name),
      name: stringField(packageJson?.openclaw?.name) || stringField(packageJson?.name),
      version: stringField(packageJson?.version),
    });
  }

  return null;
}

function createOpenClawIssue({ marker, id, name, version }) {
  return {
    format: "openclaw",
    marker,
    code: PLUGIN_FORMAT_INCOMPATIBLE_CODE,
    id,
    name,
    version,
    message: `This package looks like an OpenClaw-style plugin package (${marker}). G-SAP cannot install it directly. Use a G-SAP plugin package with manifest.json, or port it to the G-SAP plugin SDK.`,
  };
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stringField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
