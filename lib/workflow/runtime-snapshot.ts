import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT } from "../../shared/app-root.ts";

function canonical(value: any): any {
  if (typeof value === "function") return Function.prototype.toString.call(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function digest(value: any) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}

/**
 * Hash the actual local distribution, including bundled release chunks and its
 * installed dependency lock. Re-read contents to catch in-process file changes.
 */
export function getWorkflowImplementationDigest(root = APP_ROOT, runtimeFile = fileURLToPath(import.meta.url)) {
  const hash = crypto.createHash("sha256");
  let count = 0;
  function visit(relative: string) {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (["node_modules", ".git", "dist"].includes(name)) continue;
        visit(path.join(relative, name));
      }
    } else if (/\.(?:[cm]?[jt]s|json|md|yaml)$/.test(relative)) {
      hash.update(relative).update("\0").update(fs.readFileSync(absolute)).update("\0");
      count++;
    }
  }
  // APP_ROOT is the existing CODIA_ROOT-aware resolver used by official
  // distributions. Select by the executing file, never a stale sibling bundle.
  const runtimeRelative = path.relative(root, runtimeFile);
  const bundledDir = ["bundle", "dist-server-bundle"].find(dir => runtimeRelative.startsWith(dir + path.sep));
  if (bundledDir) {
    visit(bundledDir);
    for (const dir of ["lib", "shared", "packages"]) {
      if (fs.existsSync(path.join(root, dir))) visit(dir);
    }
  } else {
    for (const dir of ["core", "lib", "shared", "packages"]) visit(dir);
  }
  visit("package.json");
  visit("package-lock.json");
  if (!count) throw new Error("Workflow implementation version unavailable; execution blocked.");
  return hash.digest("hex");
}

/** Persist only digests: prompts, provider configuration and credentials never enter journals. */
export function createResolvedRuntimeSnapshot(input: {
  model: unknown; thinkingLevel: unknown; systemPrompt: unknown; tools: unknown;
  agentConfig: unknown; scope: unknown; implementation?: string;
}) {
  return {
    version: 1,
    implementation: input.implementation ?? getWorkflowImplementationDigest(),
    model: digest({ model: input.model, thinkingLevel: input.thinkingLevel }),
    prompt: digest(input.systemPrompt),
    tools: digest(input.tools),
    config: digest(input.agentConfig),
    scope: digest(input.scope),
    node: process.versions.node,
  };
}

export function assertResolvedRuntimeSnapshot(expected: unknown, actual: unknown) {
  if (!expected || digest(expected) !== digest(actual)) {
    throw new Error("Workflow resolved model, tools, prompt or runtime changed; recovery blocked.");
  }
}
