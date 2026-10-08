// @ts-nocheck
import { Type } from "@sinclair/typebox";
import { getCompanyService } from "../lib/company-service.ts";

export const name = "assign";
export const description = "PM dispatch tool for the ready-made company. Use it to split a boss command into employee task cards.";
export const parameters = Type.Object({
  companyId: Type.Optional(Type.String({ description: "公司 ID，省略时使用默认成品公司。" })),
  channelId: Type.Optional(Type.String({ description: "关联的内部频道 ID。" })),
  command: Type.String({ description: "老板命令或项目需求。" }),
  assignee: Type.Optional(Type.String({ description: "可选负责人，支持角色、员工名或 agentId。" })),
  assigneeRole: Type.Optional(Type.String({ description: "可选角色：project_manager/writer/visual_designer/video_producer/ops_qc。" })),
  dueAt: Type.Optional(Type.String({ description: "截止时间。" })),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "验收标准。" })),
  priority: Type.Optional(Type.String({ description: "优先级。" })),
});

export async function execute(params = {}, ctx = {}) {
  const tasks = await getCompanyService(ctx).assignCommand(params);
  return {
    content: [{
      type: "text",
      text: [
        `已创建 ${tasks.length} 个公司任务。`,
        ...tasks.map((task) => `- ${task.assigneeTitle}: ${task.title}`),
      ].join("\n"),
    }],
    details: { tasks },
  };
}
