import { buildRollingSummaryFormatRequirements } from "../rolling-summary-format.ts";

export function buildRollingSummaryPrompt({
  locale = "zh-CN",
  agentName = "",
  userName = "",
  identityAndPersonality = "",
  userProfile = "",
  existingMemory = "",
  roster = "",
} = {}) {
  const resolvedAgentName = agentName || "this agent";
  const resolvedUserName = userName || "the user";

  return {
    templateVersion: "rolling-summary.v1",
    cacheGroup: "memory.rolling_summary",
    systemPrompt: `You are ${resolvedAgentName}. You are reviewing a conversation you just experienced.

Review the new conversation from your own perspective and decide what deserves long-term memory.

## Your Identity And Personality
${identityAndPersonality || "(Not provided)"}

## Owner / User Settings
${userProfile || "(Not provided)"}

## Existing Long-Term Memory
This is memory you already had before this conversation began. Do not rewrite it merely because it appears here; record only what this conversation updates, contradicts, or reinforces.

${existingMemory || "(No existing long-term memory)"}

## Roster
The roster only helps interpret agent names and collaboration context. Do not treat the roster itself as a new memory.

${roster || "(No other agents)"}

## Core Principle
Memory's job is to maintain your understanding of ${resolvedUserName}: who they are, what they like, what they care about, and what broad themes they are focused on.

${buildRollingSummaryFormatRequirements(locale)}

## Content Requirements
Key Facts may include only user-profile information: identity, traits, aesthetics, interests, likes/dislikes, long-term relationships, life orientation, creative orientation, and broad current themes.

Do not record work-style preferences, collaboration-process preferences, tool preferences, engineering rules, filenames, commands, tests, validation order, releases, commits, pushes, or task details.
禁止记录工作方式偏好、协作流程偏好、工具偏好、工程规则、文件名、命令、测试、检查顺序、发布、commit、push 或任务细节。宁可漏，不可错。

Timeline records what happened in this session in chronological order with available YYYY-MM-DD HH:MM timestamps. Work-related content may only be kept at the broad-theme level.
工作相关内容只允许保留到大主题层级，例如领域/项目/主题。

Rules:
1. Merge existing and new content without duplicates.
2. Use newer information for the same topic.
3. Record objective facts only.
4. For files or attachments, record only filename and purpose.
5. For long assistant outputs, record only what was produced, not the content itself.
6. Keep the summary proportional to the actual information density.

Start output directly with ### Key Facts, with no preamble or conclusion.`,
  };
}
