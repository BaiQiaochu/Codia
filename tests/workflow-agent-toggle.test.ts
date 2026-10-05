import { describe, expect, it } from "vitest";
import {
  OPTIONAL_TOOL_NAMES,
  DEFAULT_DISABLED_TOOL_NAMES,
  computeToolSnapshot,
} from "../shared/tool-categories.ts";

// workflow 从「全局高权限设置页开关」迁移为「per-agent 工具开关」：
// 纳入与否由 agent config 的 tools.disabled + computeToolSnapshot 决定，默认关。
// （旧的 _isWorkflowEnabled / 全局 settings 机制已移除。）
describe("workflow per-agent toggle", () => {
  it("workflow 是 per-agent OPTIONAL 工具", () => {
    expect(OPTIONAL_TOOL_NAMES).toContain("workflow");
  });

  it("workflow 默认关（在 DEFAULT_DISABLED_TOOL_NAMES）", () => {
    expect(DEFAULT_DISABLED_TOOL_NAMES).toContain("workflow");
  });

  it("tools.disabled 含 workflow 时从工具快照中过滤掉", () => {
    expect(computeToolSnapshot(["read", "workflow"], ["workflow"])).toEqual(["read"]);
  });

  it("tools.disabled 不含 workflow 时保留在工具快照中", () => {
    expect(computeToolSnapshot(["read", "workflow"], [])).toContain("workflow");
  });
});
