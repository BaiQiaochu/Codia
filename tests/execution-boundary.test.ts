import { describe, expect, it } from "vitest";

describe("execution boundary contract", () => {
  it("creates a stable local process boundary for a Studio on a ServerNode", async () => {
    const { createLocalExecutionBoundary } = await import("../core/execution-boundary.js");

    const boundary = createLocalExecutionBoundary({
      serverNodeId: "server_node_1",
      studioId: "studio_1",
      workbenchRoot: "/Users/example/Desktop/project",
    });

    expect(boundary).toEqual({
      schemaVersion: 1,
      boundaryId: "execb_server_node_1_studio_1",
      kind: "local_process",
      serverNodeId: "server_node_1",
      studioId: "studio_1",
      workbench: {
        kind: "legacy_agent_workbench",
        root: "/Users/example/Desktop/project",
      },
      sandbox: {
        kind: "legacy_session_permission",
        enforcedBy: "existing_runtime",
      },
      filesystem: {
        policy: "legacy_workbench_scope",
      },
      network: {
        policy: "local_runtime_default",
      },
    });
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.workbench)).toBe(true);
  });

  it("derives a runtime-level boundary without selecting a session workbench", async () => {
    const { createRuntimeExecutionBoundary } = await import("../core/execution-boundary.js");

    expect(createRuntimeExecutionBoundary({
      serverId: "server_runtime",
      studioId: "studio_runtime",
    })).toMatchObject({
      boundaryId: "execb_server_runtime_studio_runtime",
      serverNodeId: "server_runtime",
      studioId: "studio_runtime",
      workbench: {
        root: null,
      },
    });
  });

  it("fails explicitly when required scope is missing", async () => {
    const { createLocalExecutionBoundary } = await import("../core/execution-boundary.js");

    expect(() => createLocalExecutionBoundary({ studioId: "studio_only" }))
      .toThrow("execution boundary requires serverNodeId");
    expect(() => createLocalExecutionBoundary({ serverNodeId: "node_only" }))
      .toThrow("execution boundary requires studioId");
  });
});
