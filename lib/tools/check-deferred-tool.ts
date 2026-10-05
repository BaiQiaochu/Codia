import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";

type DeferredStore = {
  listBySession: (sessionPath: string) => Array<{
    taskId: string;
    status: string;
    deferredAt: string | number | Date;
    result?: unknown;
    reason?: unknown;
    meta?: Record<string, unknown>;
  }>;
};

type CreateCheckDeferredToolOptions = {
  getDeferredStore: () => DeferredStore | null;
  getSessionPath?: () => string | null;
};

export function createCheckDeferredTool({ getDeferredStore }: CreateCheckDeferredToolOptions) {
  return {
    name: "check_pending_tasks",
    label: "检查后台任务",
    description: "查询当前对话中所有后台异步任务的状态，包括图片/视频生成、subagent、后台终端等。只返回本次对话的任务。",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "按状态过滤：pending / resolved / failed。不传则返回全部。" }),
      ),
    }),
    execute: async (_toolCallId: string, params: { status?: string } = {}, _signal: unknown, _onUpdate: unknown, ctx: unknown) => {
      const store = getDeferredStore();
      if (!store) {
        return { content: [{ type: "text", text: "异步任务存储未初始化。" }] };
      }

      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return { content: [{ type: "text", text: "当前无活动 session。" }] };
      }

      const all = store.listBySession(sessionPath);
      const filtered = params.status
        ? all.filter((task) => task.status === params.status)
        : all;

      if (!filtered.length) {
        const qualifier = params.status ? `（状态：${params.status}）` : "";
        return { content: [{ type: "text", text: `当前对话没有后台任务${qualifier}。` }] };
      }

      const summary = filtered.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        type: task.meta?.type || "unknown",
        deferredAt: new Date(task.deferredAt).toISOString(),
        ...(task.result != null && { result: task.result }),
        ...(task.reason != null && { reason: task.reason }),
        ...(task.meta && Object.keys(task.meta).length > 1 && { meta: task.meta }),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}
