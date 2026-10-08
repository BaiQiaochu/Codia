export const QUICK_ACTIONS = {
  ideas: { title: '整理我的想法', prompt: '请整理用户提供的想法，明确目标、疑问和可执行的下一步。材料不足时先询问，不要虚构。' },
  code: { title: '开始编程协作', prompt: '请结合当前工作空间协作完成编程任务。先了解相关代码和约束，再进行必要的小步修改与验证；缺少具体目标时先询问。' },
  workflow: { title: '搭建一个工作流', prompt: '请创建可编辑的工作流模板草稿。' },
  agents: { title: '问问我的 Agent', prompt: '请邀请所选助手独立审阅用户的任务，结合审阅意见完成回答。' },
} as const;
export type QuickActionId = keyof typeof QUICK_ACTIONS;
export function isQuickActionId(value: unknown): value is QuickActionId {
  return typeof value === 'string' && Object.hasOwn(QUICK_ACTIONS, value);
}
export interface ComposerReferences {
  quickAction?: QuickActionId;
  agentMentions: Array<{ agentId: string; label: string }>;
  sessionRefs: Array<{ sessionId: string; label: string }>;
}
export interface AgentReviewState {
  requestId: string;
  status: 'running' | 'continuing' | 'completed' | 'failed' | 'cancelled';
  reviewerAgentId: string;
  reviewerAgentName: string;
  reviewerSessionId?: string;
  result?: string;
  error?: string;
}
