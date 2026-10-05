import { describe, expect, it } from "vitest";
import { extractMeta } from "../lib/workflow/meta.ts";

describe("workflow meta extraction", () => {
  it("提取合法 meta 并剥离 export", () => {
    const script = `export const meta = { name: 'demo', description: '演示' }\nreturn 1 + 1`;
    const { meta, body } = extractMeta(script);
    expect(meta.name).toBe("demo");
    expect(meta.description).toBe("演示");
    expect(body).not.toMatch(/export\s+const\s+meta/);
    expect(body).toMatch(/const meta =/);
  });

  it("剥离 export default 转成入口调用，杂散 export 前缀剥成局部声明", () => {
    const script = `export const meta = { name: 'x', description: 'd' }\nexport const helper = 1\nexport default async function(api){ return helper }`;
    const { body } = extractMeta(script);
    expect(body).not.toMatch(/export\s+default/);
    expect(body).not.toMatch(/export\s+const\s+helper/);
    expect(body).toMatch(/__wf_default/); // export default 被转成入口变量 + 调用
  });

  it("meta 含 phases 数组也能解析", () => {
    const script = `export const meta = { name: 'a', description: 'b', phases: [{ title: 'X' }] }\nreturn []`;
    const { meta } = extractMeta(script);
    expect(meta.phases).toEqual([{ title: "X" }]);
  });

  it("缺 meta 抛错", () => {
    expect(() => extractMeta(`return 1`)).toThrow(/必须以 export const meta/);
  });

  it("meta 缺 name/description 抛错", () => {
    expect(() => extractMeta(`export const meta = { name: 'x' }\nreturn 1`)).toThrow(/name 和 description/);
  });

  it("空脚本抛错", () => {
    expect(() => extractMeta("")).toThrow(/不能为空/);
  });
});
