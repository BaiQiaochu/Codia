// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { getCompanyService } from "../lib/company-service.ts";

export const name = "report";
export const description = "Report progress for the calling agent's assigned company task and update the task state.";
export const parameters = Type.Object({
  companyId: Type.Optional(Type.String({ description: "Company ID. Defaults to the built-in company." })),
  channelId: Type.Optional(Type.String({ description: "Current internal channel ID." })),
  taskId: Type.Optional(Type.String({ description: "Specific task ID. If omitted, the latest matching task for this agent is used." })),
  taskTitle: Type.Optional(Type.String({ description: "Optional title fragment used to match the task when taskId is omitted." })),
  status: Type.Optional(Type.String({ description: "assigned, in_progress, reported, completed, awaiting_approval, blocked, or failed." })),
  report: Type.Optional(Type.String({ description: "Progress, result, blocker, or completion summary." })),
  acceptanceResults: Type.Optional(Type.Array(Type.Object({
    criterion: Type.String({ description: "Exact acceptance criterion being checked." }),
    passed: Type.Boolean(),
    evidence: Type.String({ description: "Concrete evidence supporting the check; not hidden reasoning." }),
  }))),
  artifacts: Type.Optional(Type.Array(Type.Any(), { description: "Optional artifacts produced by the task." })),
});

export async function execute(params = {}, ctx = {}) {
  const task = await getCompanyService(ctx).reportTask({
    ...params,
    channelId: params.channelId || ctx.channelId || ctx.conversationId,
    agentId: params.agentId || ctx.agentId,
  });
  return {
    content: [{
      type: "text",
      text: `Updated company task ${task.id}: ${task.status}`,
    }],
    details: { task },
  };
}
