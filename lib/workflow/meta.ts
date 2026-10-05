import vm from "node:vm";

export type WorkflowMeta = {
  name: string;
  description: string;
  phases?: unknown[];
};

export function extractMeta(script: unknown): { meta: WorkflowMeta; body: string } {
  if (typeof script !== "string" || !script.trim()) {
    throw new Error("workflow script 不能为空");
  }

  const marker = /export\s+const\s+meta\s*=/.exec(script);
  if (!marker) {
    throw new Error("workflow script 必须以 export const meta = {...} 开头");
  }

  const braceStart = script.indexOf("{", marker.index + marker[0].length);
  if (braceStart === -1) throw new Error("workflow meta 必须是对象字面量");
  const braceEnd = matchBrace(script, braceStart);
  if (braceEnd === -1) throw new Error("workflow meta 对象字面量未闭合");

  const literal = script.slice(braceStart, braceEnd + 1);
  let meta: unknown;
  try {
    meta = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 500 });
  } catch (err) {
    throw new Error(`workflow meta 不是合法对象字面量: ${err?.message || String(err)}`);
  }

  if (!meta || typeof meta !== "object"
    || typeof (meta as WorkflowMeta).name !== "string"
    || typeof (meta as WorkflowMeta).description !== "string") {
    throw new Error("workflow meta 必须包含 name 和 description 字符串");
  }

  const strippedMeta =
    script.slice(0, marker.index) +
    script.slice(marker.index).replace(/export\s+const\s+meta/, "const meta");
  return { meta: meta as WorkflowMeta, body: normalizeExports(strippedMeta) };
}

function normalizeExports(body: string): string {
  let hasDefault = false;
  let out = body.replace(/export\s+default\s+/, () => {
    hasDefault = true;
    return "const __wf_default = ";
  });
  out = out.replace(/export\s+(?=(?:const|let|var|function|class|async)\b)/g, "");
  if (hasDefault) {
    out += "\n;return await (typeof __wf_default === 'function' ? __wf_default(__wf_api) : __wf_default);";
  }
  return out;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
