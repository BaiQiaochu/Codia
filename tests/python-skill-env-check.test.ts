// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillCreatorCheck = path.join(repoRoot, "skills2set", "skill-creator", "scripts", "check_env.mjs");
const pluginCreatorCheck = path.join(repoRoot, "skills2set", "codia-plugin-creator", "scripts", "check_env.mjs");

function isolatedPathEnv(directory) {
  const env = { ...process.env, PATH: directory };
  for (const key of Object.keys(env)) {
    if (key !== "PATH" && key.toLowerCase() === "path") {
      delete env[key];
    }
  }
  delete env.CODIA_SKILL_CREATOR_PYTHON;
  delete env.CODIA_PLUGIN_CREATOR_PYTHON;
  return env;
}

function runCheck(scriptPath, args, env) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    json: JSON.parse(result.stdout),
  };
}

function makeFakePython(root) {
  const fakePython = path.join(root, "fake-python.cjs");
  fs.writeFileSync(
    fakePython,
    `const codeIndex = process.argv.indexOf("-c");
const code = codeIndex >= 0 ? process.argv[codeIndex + 1] : "";
const version = process.env.FAKE_PYTHON_VERSION || "3.11.8";
const [major, minor, micro] = version.split(".").map((part) => Number(part));
function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
if (code.includes("sys.version_info")) {
  write({ version, major, minor, micro, executable: "/fake/python" });
  process.exit(0);
}
if (code.includes("importlib.util.find_spec")) {
  const specs = JSON.parse(process.argv.at(-1));
  const missing = new Set((process.env.FAKE_MISSING_PACKAGES || "").split(",").filter(Boolean));
  const packages = {};
  for (const spec of specs) {
    packages[spec.packageName] = {
      ok: !missing.has(spec.packageName),
      moduleName: spec.moduleName,
      packageName: spec.packageName,
    };
  }
  write({ packages });
  process.exit(0);
}
write({ error: "unexpected code" });
process.exit(2);
`,
  );
  return fakePython;
}

describe("skill-creator environment check", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing Python before running skill-creator scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-skill-creator-env-"));
    roots.push(root);

    const result = runCheck(skillCreatorCheck, ["--capability", "quick-validate"], isolatedPathEnv(root));

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "python_not_found",
    });
  });

  it("reports PyYAML as a missing package for validation and packaging", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-skill-creator-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(skillCreatorCheck, ["--capability", "package-skill"], {
      ...isolatedPathEnv(root),
      CODIA_SKILL_CREATOR_PYTHON: JSON.stringify([process.execPath, fakePython]),
      FAKE_MISSING_PACKAGES: "pyyaml",
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "missing_dependency",
    });
    expect(result.json.missingPackages.map((entry) => entry.packageName)).toEqual(["pyyaml"]);
  });

  it("reports missing Claude CLI for trigger eval runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-skill-creator-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(skillCreatorCheck, ["--capability", "run-eval"], {
      ...isolatedPathEnv(root),
      CODIA_SKILL_CREATOR_PYTHON: JSON.stringify([process.execPath, fakePython]),
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "missing_command",
    });
    expect(result.json.missingCommands).toEqual(["claude"]);
  });
});

describe("codia-plugin-creator environment check", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing Python before running plugin scaffold scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-creator-env-"));
    roots.push(root);

    const result = runCheck(pluginCreatorCheck, ["--capability", "scaffold"], isolatedPathEnv(root));

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "python_not_found",
    });
  });

  it("passes plugin scaffold preflight with supported Python and no Python packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-plugin-creator-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(pluginCreatorCheck, ["--capability", "scaffold"], {
      ...isolatedPathEnv(root),
      CODIA_PLUGIN_CREATOR_PYTHON: JSON.stringify([process.execPath, fakePython]),
    });

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      code: "ok",
    });
    expect(result.json.requiredPackages.all).toEqual([]);
  });
});
