// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { getCompanyService } from "../lib/company-service.ts";

export const name = "status";
export const description = "Read company status, employee roster, channel bindings, and current task states.";
export const parameters = Type.Object({
  companyId: Type.Optional(Type.String({ description: "公司 ID，省略时使用默认成品公司。" })),
});

export async function execute(params = {}, ctx = {}) {
  const status = await getCompanyService(ctx).getStatus(params.companyId);
  const lines = [
    `${status.company.name}`,
    `员工：${status.summary.employeeCount}`,
    `频道：${status.summary.channelCount}`,
    `任务：${status.summary.taskCount}`,
  ];
  for (const task of status.tasks.slice(0, 10)) {
    lines.push(`- ${task.assigneeTitle} · ${task.status} · ${task.title}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: status,
  };
}
