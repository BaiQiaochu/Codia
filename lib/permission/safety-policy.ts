const GIT_PUSH_RULES = {
  force: {
    id: "force-push-blocked",
    reason: "Force push is blocked by SafetyPolicy.",
  },
  tags: {
    id: "push-tags-blocked",
    reason: "Pushing tags is blocked by SafetyPolicy.",
  },
  push: {
    id: "privacy-push-required",
    reason: "Git remote push must go through /privacy-push and explicit final user confirmation.",
  },
};

function commandFromRequest(request: any = {}) {
  const command = request.params?.command || request.params?.cmd || request.target?.label;
  return typeof command === "string" ? command : "";
}

function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function executableBasename(token: string) {
  const normalized = String(token || "").replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function isGitExecutableToken(token: string) {
  const base = executableBasename(token);
  return base === "git" || base === "git.exe";
}

function nestedShellCommand(tokens: string[], index: number) {
  const base = executableBasename(tokens[index]);
  const isPosixShell = base === "sh" || base === "sh.exe"
    || base === "bash" || base === "bash.exe"
    || base === "zsh" || base === "zsh.exe"
    || base === "fish" || base === "fish.exe";
  if (isPosixShell) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--") return null;
      if (token === "-c" || token === "-lc" || (/^-[^-]+$/.test(token) && token.includes("c"))) return tokens[i + 1] || null;
      if (!token.startsWith("-")) return null;
    }
    return null;
  }

  const isPowerShell = base === "powershell" || base === "powershell.exe"
    || base === "pwsh" || base === "pwsh.exe";
  if (isPowerShell) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = String(tokens[i] || "").toLowerCase();
      if (token === "-command" || token === "-c" || token === "/c") return tokens[i + 1] || null;
    }
    return null;
  }

  if (base === "cmd" || base === "cmd.exe") {
    for (let i = index + 1; i < tokens.length; i += 1) {
      const token = String(tokens[i] || "").toLowerCase();
      if (token === "/c" || token === "-c") return tokens[i + 1] || null;
    }
  }
  return null;
}

function gitGlobalOptionConsumesValue(token: string) {
  if (token.includes("=")) return false;
  return token === "-C"
    || token === "-c"
    || token === "--git-dir"
    || token === "--work-tree"
    || token === "--namespace"
    || token === "--exec-path"
    || token === "--config-env"
    || token === "--super-prefix";
}

function detectGitPush(command: string, depth = 0): null | { hasForce: boolean; hasTags: boolean } {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (depth < 3) {
      const nested = nestedShellCommand(tokens, i);
      if (nested) {
        const nestedGitPush = detectGitPush(nested, depth + 1);
        if (nestedGitPush) return nestedGitPush;
      }
    }
    if (!isGitExecutableToken(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j];
      if (token === "push") {
        const args = tokens.slice(j + 1);
        return {
          hasForce: args.some((arg) => arg === "--force" || arg.startsWith("--force-with-lease")),
          hasTags: args.includes("--tags"),
        };
      }
      if (token === "--") break;
      if (token.startsWith("-")) {
        j += gitGlobalOptionConsumesValue(token) ? 2 : 1;
        continue;
      }
      break;
    }
  }
  return null;
}

export function evaluateToolSafetyPolicy(request: any = {}) {
  const command = commandFromRequest(request);
  if (!command) return null;
  const gitPush = detectGitPush(command);
  if (!gitPush) return null;
  const rule = gitPush.hasForce
    ? GIT_PUSH_RULES.force
    : (gitPush.hasTags ? GIT_PUSH_RULES.tags : GIT_PUSH_RULES.push);
  return {
    action: "block",
    code: "ACTION_BLOCKED_BY_SAFETY_POLICY",
    reviewer: "safety_policy",
    reason: rule.reason,
    risk: "critical",
    ruleIds: [rule.id],
  };
}
