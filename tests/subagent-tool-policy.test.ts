import { describe, expect, it, afterEach } from "vitest";
import {
  resolveSubagentToolAccess,
  resolveSubagentToolStrategy,
  SubagentAccessDeniedError,
} from "../lib/tools/subagent-tool-policy.js";

describe("subagent 工具访问策略收口（Codex 式：显式 access + 继承父会话档）", () => {
  afterEach(() => {
    delete process.env.GSAP_SUBAGENT_TOOL_STRATEGY;
    delete process.env.HANA_SUBAGENT_TOOL_STRATEGY;
  });

  it("默认 intercept（甲）：不剥离工具（filter=null）", () => {
    const a = resolveSubagentToolAccess({ access: "write" });
    expect(a).toMatchObject({
      strategy: "intercept",
      customToolFilter: null,
      builtinToolFilter: null,
      subagentContext: true,
    });
  });

  // ── 显式 access 参数决定权限档（优先级最高） ──
  it("access:read → READ_ONLY", () => {
    expect(resolveSubagentToolAccess({ access: "read" }).permissionMode).toBe("read_only");
    // 即便父会话可操作，显式 read 仍压成只读
    expect(resolveSubagentToolAccess({ access: "read", parentPermissionMode: "operate" }).permissionMode).toBe("read_only");
  });

  it("access:write → OPERATE", () => {
    expect(resolveSubagentToolAccess({ access: "write" }).permissionMode).toBe("operate");
    // 即便父会话只读，显式 write 仍可操作
    expect(resolveSubagentToolAccess({ access: "write", parentPermissionMode: "operate" }).permissionMode).toBe("operate");
    expect(resolveSubagentToolAccess({ access: "write", parentPermissionMode: "ask" }).permissionMode).toBe("operate");
  });

  it("denies explicit write access when the parent session is read-only", () => {
    expect(() => resolveSubagentToolAccess({ access: "write", parentPermissionMode: "read_only" }))
      .toThrow(SubagentAccessDeniedError);

    try {
      resolveSubagentToolAccess({ access: "write", parentPermissionMode: "read_only" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY");
      expect(err.message).toMatch(/read-only/i);
    }
  });

  it("denies explicit write under strip strategy when the parent session is read-only", () => {
    expect(() => resolveSubagentToolAccess({
      access: "write",
      parentPermissionMode: "read_only",
      strategy: "strip",
    })).toThrow(SubagentAccessDeniedError);
  });

  it("allows read or inherited access when the parent session is read-only", () => {
    expect(resolveSubagentToolAccess({ access: "read", parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
    expect(resolveSubagentToolAccess({ parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
  });

  // ── 省略 access → 继承父会话档，但 subagent 只有两态（后台不能交互确认，ASK 不可用） ──
  it("省略 access：父只读 → 只读", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
  });

  it("省略 access：父可操作 → 可操作", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "operate" }).permissionMode).toBe("operate");
  });

  it("省略 access：父先问(ask) → 可操作（后台无法交互确认，ASK 坍缩为 operate，绝不让 subagent 挂在确认上）", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "ask" }).permissionMode).toBe("operate");
  });

  it("省略 access + 无父档 → 可操作（= 历史默认行为，subagent 一向全权）", () => {
    expect(resolveSubagentToolAccess({}).permissionMode).toBe("operate");
    expect(resolveSubagentToolAccess().permissionMode).toBe("operate");
  });

  it("非法 access 值按省略处理（继承父档）", () => {
    expect(resolveSubagentToolAccess({ access: "garbage", parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
    expect(resolveSubagentToolAccess({ access: "garbage", parentPermissionMode: "operate" }).permissionMode).toBe("operate");
  });

  // ── 乙策略（strip）：按权限档剥离工具清单 ──
  it("strip（乙）：write 档剥离全集清单", () => {
    const a = resolveSubagentToolAccess({ access: "write", strategy: "strip" });
    expect(a.strategy).toBe("strip");
    expect(a.builtinToolFilter).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    expect(a.customToolFilter).toEqual(["web_search", "web_fetch", "todo_write", "browser"]);
    expect(a.permissionMode).toBe("operate");
  });

  it("strip（乙）：read 档剥离到 builtin 只读子集", () => {
    const a = resolveSubagentToolAccess({ access: "read", strategy: "strip" });
    expect(a.builtinToolFilter).toEqual(["read", "grep", "find", "ls"]);
    expect(a.permissionMode).toBe("read_only");
  });

  it("strip（乙）：继承父只读档也走只读子集", () => {
    const a = resolveSubagentToolAccess({ parentPermissionMode: "read_only", strategy: "strip" });
    expect(a.builtinToolFilter).toEqual(["read", "grep", "find", "ls"]);
    expect(a.permissionMode).toBe("read_only");
  });

  it("env GSAP_SUBAGENT_TOOL_STRATEGY=strip 切到乙（性能 A/B 开关）", () => {
    process.env.GSAP_SUBAGENT_TOOL_STRATEGY = "strip";
    expect(resolveSubagentToolStrategy()).toBe("strip");
    expect(resolveSubagentToolAccess({ access: "write" }).strategy).toBe("strip");
  });

  it("keeps HANA_SUBAGENT_TOOL_STRATEGY as a legacy fallback", () => {
    process.env.HANA_SUBAGENT_TOOL_STRATEGY = "strip";
    expect(resolveSubagentToolStrategy()).toBe("strip");
  });

  it("默认策略 intercept", () => {
    expect(resolveSubagentToolStrategy()).toBe("intercept");
  });
});
