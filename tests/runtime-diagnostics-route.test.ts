import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRuntimeDiagnosticsService } from "../server/runtime-diagnostics-service.js";
import { createRuntimeDiagnosticsRoute } from "../server/routes/runtime-diagnostics.js";
import { createRuntimeTraceStore } from "../core/runtime-trace-store.js";

describe("runtime diagnostics route", () => {
  it("returns recent redacted diagnostics and records", async () => {
    const app = new Hono();
    const service = createRuntimeDiagnosticsService({ appName: "G-SAP" });
    const diagnosticId = service.recordDiagnostic({
      traceId: "trace-route",
      sessionPath: "E:/sessions/a.jsonl",
      severity: "error",
      category: "model",
      userMessage: "Model call failed. Diagnostics were saved.",
      technicalMessage: "provider rejected sk-secret-token at C:/Users/ghost/.gsap/config.json",
      sanitizedDetails: {
        authorization: "Bearer sk-secret-token",
        filePath: "C:/Users/ghost/.gsap/config.json",
      },
    });
    service.recordRuntimeRecord({
      id: "record-route",
      timestamp: "2026-05-21T00:00:00.000Z",
      severity: "error",
      category: "model",
      title: "Model call failed",
      traceId: "trace-route",
      diagnosticId,
    });

    app.route("/api", createRuntimeDiagnosticsRoute(service));

    const res = await app.request("/api/diagnostics/runtime");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      app: "G-SAP",
      diagnostics: [expect.objectContaining({ id: diagnosticId, traceId: "trace-route" })],
      records: [expect.objectContaining({ id: "record-route", diagnosticId })],
    });
    expect(JSON.stringify(data)).not.toContain("sk-secret-token");
    expect(JSON.stringify(data)).toContain("config.json");
  });

  it("returns lifecycle traces without changing the diagnostics response contract", async () => {
    const app = new Hono();
    const traceStore = createRuntimeTraceStore({
      now: () => "2026-05-23T00:00:00.000Z",
    });
    const trace = traceStore.startTrace({
      traceId: "trace-runtime",
      sessionPath: "E:/sessions/main.jsonl",
      agentId: "gsap",
    });
    traceStore.recordPhase(trace.traceId, "input.received", {
      summary: "prompt accepted",
      details: { filePath: "C:/Users/ghost/.codex/auth.json", authorization: "Bearer sk-secret-token" },
    });
    traceStore.endTrace(trace.traceId, { status: "completed" });
    const service = createRuntimeDiagnosticsService({ appName: "G-SAP", traceStore });

    app.route("/api", createRuntimeDiagnosticsRoute(service));

    const res = await app.request("/api/diagnostics/runtime");
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      diagnostics: [],
      records: [],
      traces: [
        expect.objectContaining({
          traceId: "trace-runtime",
          status: "completed",
          phases: [expect.objectContaining({ phase: "input.received" })],
        }),
      ],
    });
    expect(JSON.stringify(data)).not.toContain("sk-secret-token");
    expect(JSON.stringify(data)).toContain("auth.json");
  });
});
