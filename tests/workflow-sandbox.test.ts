import { describe, expect, it } from "vitest";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";

const META = `export const meta = { name: 't', description: 'd' }\n`;

describe("workflow sandbox", () => {
  it("跑脚本并返回 return 值", async () => {
    const { result, meta } = await runWorkflowScript(META + `return 1 + 2`, {});
    expect(result).toBe(3);
    expect(meta.name).toBe("t");
  });

  it("支持 export default async function 形态：解构注入的 host API，函数返回值即结果", async () => {
    const host = { greet: (n) => `hi ${n}` };
    const script = META + `export default async function({ greet }) { return await greet('hana'); }`;
    const { result } = await runWorkflowScript(script, host);
    expect(result).toBe("hi hana");
  });

  it("支持 export default 箭头函数形态", async () => {
    const host = { val: 7 };
    const script = META + `export default async ({ val }) => val * 2`;
    const { result } = await runWorkflowScript(script, host);
    expect(result).toBe(14);
  });

  it("export default 函数与顶层全局 API 等价（两种写法都能跑）", async () => {
    const host = { agent: async (p) => `[${p}]` };
    const top = META + `return await agent('x')`;
    const def = META + `export default async function({ agent }) { return await agent('x'); }`;
    expect((await runWorkflowScript(top, host)).result).toBe("[x]");
    expect((await runWorkflowScript(def, host)).result).toBe("[x]");
  });

  it("脚本能 await 注入的 host 函数", async () => {
    const host = { greet: async (n) => `hi ${n}` };
    const { result } = await runWorkflowScript(META + `return await greet('hana')`, host);
    expect(result).toBe("hi hana");
  });

  it("脚本拿不到 require / process（沙箱隔离）", async () => {
    await expect(runWorkflowScript(META + `return typeof require`, {}))
      .resolves.toMatchObject({ result: "undefined" });
    await expect(runWorkflowScript(META + `return typeof process`, {}))
      .resolves.toMatchObject({ result: "undefined" });
  });

  it("脚本内 Math.random / Date.now 被禁用", async () => {
    await expect(runWorkflowScript(META + `return Math.random()`, {}))
      .rejects.toThrow(/非确定性/);
  });

  it("超过 deadline 的 async 脚本被中止", async () => {
    const host = { sleep: () => new Promise((r) => setTimeout(r, 1000)) };
    await expect(runWorkflowScript(META + `await sleep(); return 1`, host, { deadlineMs: 30 }))
      .rejects.toThrow(/超时/);
  });

  it("AbortSignal 中止脚本", async () => {
    const ac = new AbortController();
    const host = { sleep: () => new Promise((r) => setTimeout(r, 1000)) };
    const p = runWorkflowScript(META + `await sleep(); return 1`, host, { signal: ac.signal, deadlineMs: 5000 });
    ac.abort();
    await expect(p).rejects.toThrow(/中止/);
  });
});
