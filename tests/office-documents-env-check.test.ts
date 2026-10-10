// @ts-nocheck
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "skills2set", "office-documents", "scripts", "check_env.mjs");

function isolatedPathEnv(directory) {
  const env = { ...process.env, PATH: directory };
  for (const key of Object.keys(env)) {
    if (key !== "PATH" && key.toLowerCase() === "path") {
      delete env[key];
    }
  }
  delete env.CODIA_OFFICE_PYTHON;
  return env;
}

function runCheck(args, env) {
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

describe("office-documents environment check", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a JS-level error when Python is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);

    const result = runCheck(["--capability", "read-docx"], isolatedPathEnv(root));

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "python_not_found",
    });
    expect(result.json.message).toContain("Python 3.10+");
  });

  it("rejects Python versions that cannot parse the bundled scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(["--capability", "read-docx"], {
      ...isolatedPathEnv(root),
      CODIA_OFFICE_PYTHON: JSON.stringify([process.execPath, fakePython]),
      FAKE_PYTHON_VERSION: "3.9.18",
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "python_version_unsupported",
    });
    expect(result.json.python.version).toBe("3.9.18");
  });

  it("reports malformed CODIA_OFFICE_PYTHON as structured JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);

    const result = runCheck(["--capability", "read-docx"], {
      ...isolatedPathEnv(root),
      CODIA_OFFICE_PYTHON: "[",
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "invalid_environment",
    });
    expect(result.json.message).toContain("CODIA_OFFICE_PYTHON");
  });

  it("passes baseline reads without requiring optional document libraries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(["--capability", "read-docx"], {
      ...isolatedPathEnv(root),
      CODIA_OFFICE_PYTHON: JSON.stringify([process.execPath, fakePython]),
    });

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      code: "ok",
    });
    expect(result.json.requiredPackages.all).toEqual([]);
  });

  it("reports missing optional packages for package-backed operations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(["--capability", "edit-xlsx"], {
      ...isolatedPathEnv(root),
      CODIA_OFFICE_PYTHON: JSON.stringify([process.execPath, fakePython]),
      FAKE_MISSING_PACKAGES: "openpyxl",
    });

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      code: "missing_dependency",
    });
    expect(result.json.missingPackages.map((entry) => entry.packageName)).toEqual(["openpyxl"]);
    expect(result.json.message).toContain("openpyxl");
  });

  it("allows PDF reads when any supported PDF reader package exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-office-env-"));
    roots.push(root);
    const fakePython = makeFakePython(root);

    const result = runCheck(["--capability", "read-pdf"], {
      ...isolatedPathEnv(root),
      CODIA_OFFICE_PYTHON: JSON.stringify([process.execPath, fakePython]),
      FAKE_MISSING_PACKAGES: "markitdown,pdfplumber",
    });

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      code: "ok",
    });
    expect(result.json.requiredPackages.anyOf).toEqual([["markitdown", "pdfplumber", "pypdf"]]);
  });
});
