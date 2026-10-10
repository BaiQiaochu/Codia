/**
 * Single source of truth for sandbox path policy constants.
 *
 * PathGuard and OS sandbox adapters import the same ACL constants from here.
 */

import path from "path";
import { workspaceRootsForSandbox } from "../../shared/workspace-scope.ts";

export const BLOCKED_FILES = ["auth.json", "models.json", "added-models.yaml", "crash.log"];
export const BLOCKED_DIRS = ["browser-data", "playwright-browsers"];

export const READ_ONLY_AGENT_FILES = [
  "ishiki.md",
  "config.yaml",
  "identity.md",
  "yuan.md",
];

export const READ_ONLY_HOME_DIRS = ["user", "skills", "session-files"];

export const READ_WRITE_AGENT_DIRS = [
  "memory",
  "sessions",
  "desk",
  "heartbeat",
  "book",
  "activity",
  "avatars",
];

// Codia keeps learned skill bundles read-only through PathGuard.
export const READ_ONLY_AGENT_DIRS = ["learned-skills"];
export const READ_WRITE_AGENT_FILES = ["pinned.md", "channels.md"];
export const READ_WRITE_HOME_DIRS = ["channels", "logs", "uploads", ".ephemeral"];

export const SANDBOX_ACCESS_CONTRACT = Object.freeze({
  read: "all",
  write: "scoped",
  network: "on",
});

export const SANDBOX_MODE_LABEL =
  `read-${SANDBOX_ACCESS_CONTRACT.read}_write-${SANDBOX_ACCESS_CONTRACT.write}_network-${SANDBOX_ACCESS_CONTRACT.network}`;

type SandboxMode = "standard" | "full-access";

type DeriveSandboxPolicyOptions = {
  agentDir: string;
  cwd?: string | null;
  workspace?: string | null;
  workspaceFolders?: unknown[];
  authorizedFolders?: unknown[];
  codiaHome?: string;
  runtimeWritablePaths?: unknown[];
  mode: SandboxMode;
};

function uniqueTruthy(paths: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths || []) {
    if (!raw) continue;
    const value = path.resolve(String(raw));
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function deriveSandboxPolicy({
  agentDir,
  cwd = null,
  workspace,
  workspaceFolders = [],
  authorizedFolders = [],
  codiaHome,
  runtimeWritablePaths = [],
  mode,
}: DeriveSandboxPolicyOptions) {
  if (mode === "full-access") {
    return { mode: "full-access" };
  }

  const home = codiaHome || codiaHome;
  if (!home) {
    throw new Error("deriveSandboxPolicy requires codiaHome or codiaHome");
  }

  const workspaceRoots = uniqueTruthy([
    ...workspaceRootsForSandbox(workspace, workspaceFolders, authorizedFolders),
    ...workspaceRootsForSandbox(cwd, []),
  ]);

  return {
    mode: "standard",
    access: SANDBOX_ACCESS_CONTRACT,
    codiaHome: home,
    agentDir,
    cwd,
    workspace,
    workspaceRoots,
    allowExternalReads: true,

    writablePaths: [
      ...READ_WRITE_AGENT_DIRS.map((d) => path.join(agentDir, d)),
      ...READ_WRITE_HOME_DIRS.map((d) => path.join(home, d)),
      ...workspaceRoots,
      ...runtimeWritablePaths.map((p) => String(p)),
    ].filter(Boolean),

    readablePaths: [
      ...READ_ONLY_AGENT_FILES.map((f) => path.join(agentDir, f)),
      ...READ_ONLY_AGENT_DIRS.map((d) => path.join(agentDir, d)),
      ...READ_ONLY_HOME_DIRS.map((d) => path.join(home, d)),
    ].filter(Boolean),

    denyReadPaths: [
      ...BLOCKED_FILES.map((f) => path.join(home, f)),
      ...BLOCKED_DIRS.map((d) => path.join(home, d)),
    ],

    protectedPaths: [
      ...workspaceRoots.map((root) => path.join(root, ".git")),
      path.join(home, "session-files"),
    ].filter(Boolean),
  };
}
