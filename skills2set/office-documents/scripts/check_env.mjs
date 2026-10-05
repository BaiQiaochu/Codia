#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const MIN_PYTHON_VERSION = [3, 10, 0];
const MIN_PYTHON_VERSION_TEXT = `${MIN_PYTHON_VERSION[0]}.${MIN_PYTHON_VERSION[1]}`;
const CHECK_TIMEOUT_MS = 10_000;

const PACKAGE_SPECS = {
  markitdown: {
    packageName: "markitdown",
    moduleName: "markitdown",
    purpose: "enhanced document reading",
  },
  "python-docx": {
    packageName: "python-docx",
    moduleName: "docx",
    purpose: "rich DOCX edits",
  },
  openpyxl: {
    packageName: "openpyxl",
    moduleName: "openpyxl",
    purpose: "XLSX/XLSM edits",
  },
  "python-pptx": {
    packageName: "python-pptx",
    moduleName: "pptx",
    purpose: "rich PPTX edits",
  },
  pdfplumber: {
    packageName: "pdfplumber",
    moduleName: "pdfplumber",
    purpose: "PDF text extraction",
  },
  pypdf: {
    packageName: "pypdf",
    moduleName: "pypdf",
    purpose: "PDF reading and structural edits",
  },
};

const CAPABILITIES = {
  "read-docx": { all: [], anyOf: [] },
  "read-xlsx": { all: [], anyOf: [] },
  "read-pptx": { all: [], anyOf: [] },
  "read-pdf": { all: [], anyOf: [["markitdown", "pdfplumber", "pypdf"]] },
  "enhanced-read": { all: ["markitdown"], anyOf: [] },
  "edit-docx-basic": { all: [], anyOf: [] },
  "edit-docx-rich": { all: ["python-docx"], anyOf: [] },
  "edit-xlsx": { all: ["openpyxl"], anyOf: [] },
  "edit-pptx-basic": { all: [], anyOf: [] },
  "edit-pptx-rich": { all: ["python-pptx"], anyOf: [] },
  "edit-pdf": { all: ["pypdf"], anyOf: [] },
};

const VERSION_SCRIPT = `
import json
import sys
version = sys.version_info
print(json.dumps({
    "version": "%d.%d.%d" % (version[0], version[1], version[2]),
    "major": int(version[0]),
    "minor": int(version[1]),
    "micro": int(version[2]),
    "executable": sys.executable,
}))
`;

const IMPORT_SCRIPT = `
import importlib.util
import json
import sys
specs = json.loads(sys.argv[1])
packages = {}
for item in specs:
    package_name = item["packageName"]
    module_name = item["moduleName"]
    packages[package_name] = {
        "packageName": package_name,
        "moduleName": module_name,
        "ok": importlib.util.find_spec(module_name) is not None,
    }
print(json.dumps({"packages": packages}))
`;

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const capabilities = [];
  const packages = [];
  const unknown = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capability") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        unknown.push(arg);
      } else {
        capabilities.push(value);
      }
    } else if (arg.startsWith("--capability=")) {
      capabilities.push(arg.slice("--capability=".length));
    } else if (arg === "--package") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        unknown.push(arg);
      } else {
        packages.push(value);
      }
    } else if (arg.startsWith("--package=")) {
      packages.push(arg.slice("--package=".length));
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, capabilities, packages, unknown };
    } else {
      unknown.push(arg);
    }
  }

  return { help: false, capabilities, packages, unknown };
}

function helpResult() {
  return {
    ok: true,
    code: "help",
    message: [
      "Usage: node skills2set/office-documents/scripts/check_env.mjs [--capability name] [--package package]",
      `Requires Python ${MIN_PYTHON_VERSION_TEXT}+ for the bundled office document scripts.`,
      `Capabilities: ${Object.keys(CAPABILITIES).join(", ")}`,
      `Packages: ${Object.keys(PACKAGE_SPECS).join(", ")}`,
    ].join("\n"),
  };
}

function invalidArgsResult(unknown) {
  return {
    ok: false,
    code: "invalid_arguments",
    message: `Unknown or incomplete argument(s): ${unknown.join(", ")}`,
    capabilities: Object.keys(CAPABILITIES),
    packages: Object.keys(PACKAGE_SPECS),
  };
}

function parsePythonCommand(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid GSAP_OFFICE_PYTHON JSON value: ${reason}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string")) {
      throw new Error("GSAP_OFFICE_PYTHON JSON value must be a non-empty string array.");
    }
    return {
      command: parsed[0],
      args: parsed.slice(1),
      label: parsed.join(" "),
      source: "GSAP_OFFICE_PYTHON",
    };
  }

  return {
    command: trimmed,
    args: [],
    label: trimmed,
    source: "GSAP_OFFICE_PYTHON",
  };
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.GSAP_OFFICE_PYTHON) {
    candidates.push(parsePythonCommand(process.env.GSAP_OFFICE_PYTHON));
  }

  if (process.platform === "win32") {
    candidates.push(
      { command: "py", args: ["-3"], label: "py -3", source: "PATH" },
      { command: "python", args: [], label: "python", source: "PATH" },
      { command: "python3", args: [], label: "python3", source: "PATH" },
    );
  } else {
    candidates.push(
      { command: "python3", args: [], label: "python3", source: "PATH" },
      { command: "python", args: [], label: "python", source: "PATH" },
    );
  }

  return candidates.filter(Boolean);
}

function runCandidate(candidate, code, args = []) {
  return spawnSync(candidate.command, [...candidate.args, "-c", code, ...args], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function versionAtLeast(found) {
  const parts = [found.major, found.minor, found.micro];
  for (let index = 0; index < MIN_PYTHON_VERSION.length; index += 1) {
    if (parts[index] > MIN_PYTHON_VERSION[index]) {
      return true;
    }
    if (parts[index] < MIN_PYTHON_VERSION[index]) {
      return false;
    }
  }
  return true;
}

function findPython() {
  const attempted = [];
  let unsupported = null;

  for (const candidate of pythonCandidates()) {
    const result = runCandidate(candidate, VERSION_SCRIPT);
    const attempt = {
      command: candidate.label,
      source: candidate.source,
      status: result.status,
      error: result.error ? result.error.message : undefined,
      stderr: result.stderr ? result.stderr.trim() : undefined,
    };
    attempted.push(attempt);

    if (result.error || result.status !== 0) {
      continue;
    }

    try {
      const version = parseJsonOutput(result.stdout);
      if (!version) {
        attempt.error = "Python version check returned no JSON.";
        continue;
      }

      const python = {
        ok: true,
        command: candidate.label,
        source: candidate.source,
        executable: version.executable,
        version: version.version,
        major: Number(version.major),
        minor: Number(version.minor),
        micro: Number(version.micro),
        minimumVersion: MIN_PYTHON_VERSION_TEXT,
      };

      if (versionAtLeast(python)) {
        return { ok: true, python, runner: candidate, attempted };
      }

      unsupported ??= { ok: false, python, attempted };
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (unsupported) {
    return {
      ok: false,
      code: "python_version_unsupported",
      python: { ...unsupported.python, ok: false },
      attempted,
      message: `Office document scripts require Python ${MIN_PYTHON_VERSION_TEXT}+; found ${unsupported.python.version} at ${unsupported.python.command}.`,
    };
  }

  return {
    ok: false,
    code: "python_not_found",
    python: {
      ok: false,
      minimumVersion: MIN_PYTHON_VERSION_TEXT,
    },
    attempted,
    message: `Office document scripts require Python ${MIN_PYTHON_VERSION_TEXT}+. Install Python or set GSAP_OFFICE_PYTHON to a Python executable, then retry.`,
  };
}

function assertKnownCapabilities(capabilities) {
  return capabilities.filter((capability) => !CAPABILITIES[capability]);
}

function assertKnownPackages(packages) {
  return packages.filter((packageName) => !PACKAGE_SPECS[packageName]);
}

function collectRequirements(capabilities, packages) {
  const all = new Set();
  const anyOf = [];

  for (const packageName of packages) {
    all.add(packageName);
  }

  for (const capability of capabilities) {
    const requirement = CAPABILITIES[capability];
    for (const packageName of requirement.all) {
      all.add(packageName);
    }
    for (const group of requirement.anyOf) {
      anyOf.push([...group]);
    }
  }

  return {
    all: [...all],
    anyOf,
  };
}

function packagesToCheck(requirements) {
  return [...new Set([...requirements.all, ...requirements.anyOf.flat()])]
    .map((packageName) => PACKAGE_SPECS[packageName]);
}

function checkPackages(runner, packageSpecs) {
  if (packageSpecs.length === 0) {
    return {};
  }

  const result = runCandidate(runner, IMPORT_SCRIPT, [JSON.stringify(packageSpecs)]);
  if (result.error || result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : "";
    throw new Error(`Python package check failed: ${result.error?.message || stderr || "unknown error"}`);
  }

  const parsed = parseJsonOutput(result.stdout);
  return parsed?.packages || {};
}

function evaluatePackages(requirements, packageStatus) {
  const missingPackages = requirements.all
    .filter((packageName) => !packageStatus[packageName]?.ok)
    .map((packageName) => PACKAGE_SPECS[packageName]);

  const missingAnyOf = requirements.anyOf
    .filter((group) => !group.some((packageName) => packageStatus[packageName]?.ok))
    .map((group) => group.map((packageName) => PACKAGE_SPECS[packageName]));

  return { missingPackages, missingAnyOf };
}

function installGuidance(packageNames) {
  if (packageNames.length === 0) {
    return [];
  }
  return [
    `Install the missing package(s) into the reported Python environment after user confirmation: ${packageNames.join(", ")}.`,
    "Do not auto-install dependencies from this skill.",
  ];
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    return {
      ok: false,
      code: "invalid_environment",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (args.help) {
    return helpResult();
  }

  if (args.unknown.length > 0) {
    return invalidArgsResult(args.unknown);
  }

  const unknownCapabilities = assertKnownCapabilities(args.capabilities);
  const unknownPackages = assertKnownPackages(args.packages);
  if (unknownCapabilities.length > 0 || unknownPackages.length > 0) {
    return {
      ok: false,
      code: "unknown_requirement",
      message: [
        unknownCapabilities.length ? `Unknown capability: ${unknownCapabilities.join(", ")}` : "",
        unknownPackages.length ? `Unknown package: ${unknownPackages.join(", ")}` : "",
      ].filter(Boolean).join(" "),
      capabilities: Object.keys(CAPABILITIES),
      packages: Object.keys(PACKAGE_SPECS),
    };
  }

  let pythonResult;
  try {
    pythonResult = findPython();
  } catch (error) {
    return {
      ok: false,
      code: "invalid_environment",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!pythonResult.ok) {
    return pythonResult;
  }

  const requirements = collectRequirements(args.capabilities, args.packages);
  const packageSpecs = packagesToCheck(requirements);

  let packageStatus = {};
  try {
    packageStatus = checkPackages(pythonResult.runner, packageSpecs);
  } catch (error) {
    return {
      ok: false,
      code: "dependency_check_failed",
      python: pythonResult.python,
      requiredPackages: requirements,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const { missingPackages, missingAnyOf } = evaluatePackages(requirements, packageStatus);
  const missingPackageNames = [
    ...missingPackages.map((item) => item.packageName),
    ...missingAnyOf.flatMap((group) => group.map((item) => item.packageName)),
  ];

  if (missingPackages.length > 0 || missingAnyOf.length > 0) {
    return {
      ok: false,
      code: "missing_dependency",
      python: pythonResult.python,
      requiredPackages: requirements,
      packages: packageStatus,
      missingPackages,
      missingAnyOf,
      installGuidance: installGuidance([...new Set(missingPackageNames)]),
      message: [
        missingPackages.length ? `Missing package(s): ${missingPackages.map((item) => item.packageName).join(", ")}.` : "",
        missingAnyOf.length ? `Missing one package from: ${missingAnyOf.map((group) => group.map((item) => item.packageName).join(" or ")).join("; ")}.` : "",
      ].filter(Boolean).join(" "),
    };
  }

  return {
    ok: true,
    code: "ok",
    python: pythonResult.python,
    requiredPackages: requirements,
    packages: packageStatus,
    message: "Office document skill environment is ready for the requested capability.",
  };
}

const result = main();
printResult(result);
process.exit(result.ok ? 0 : 1);
