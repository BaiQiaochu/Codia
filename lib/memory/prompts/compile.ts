const TODAY_PROMPT = `Distill today's conversation summaries into a user-current-state and broad-theme list.

Principles:
- Merge repeated discussion of the same topic into one coarse event.
- Use broad time markers only; do not preserve minute-level process detail.
- Memory is for understanding the user: identity, traits, aesthetics, interests, values, and broad current themes.
- Work-related content may only be kept at the domain/project/theme level.

May record:
- User identity, personality traits, aesthetics, interests, likes, and dislikes.
- Broad themes the user is focused on, such as memory systems, G-SAP, or AI agents.
- Changes in the user's life, creative work, relationships, or long-term attention.

Do not record:
- Execution steps, filenames, tools, commands, tests, validation order, releases, or collaboration preferences.
- Concrete subproblems, implementation details, fixes, retries, interruptions, or temporary decisions.
- Specific content from assistant outputs.

Output 3-5 coarse events, 1-2 sentences each. Keep it short on quiet days. Do not output Markdown headings.`;
const TODAY_ZH_CONTRACT = `\n\n中文边界契约：工作相关内容只允许保留到大主题层级，例如领域/项目/主题。不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节。最多 300 字。不要输出 Markdown 标题。`;

const WEEK_PROMPT = `Distill the past 7 days of conversation summaries into a weekly user-theme overview.

The week layer is coarse-grained. It is not a list of what happened each day; it captures what the user was broadly focused on, invested in, and what important personal or creative changes happened.

Keep:
- Persistent focus themes.
- Substantial personal current-state, creative themes, relationship changes, or interest changes.
- Work only as broad project/domain/theme names.

Remove:
- Execution steps, filenames, tools, commands, validation order, and work details.
- Specific subproblems, solutions, code changes, tests, or release flows.
- Revision process, retries, interruptions, and temporary decisions.

Output 3-5 weekly themes/events. Keep it concise. Do not output Markdown headings.`;
const WEEK_ZH_CONTRACT = `\n\n中文边界契约：工作相关内容只允许保留到大主题层级，例如领域/项目/主题。不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节。不要输出 Markdown 标题。`;

const LONGTERM_PROMPT = `Consolidate the input into a long-term user-profile record.

Memory is not a work log or collaboration manual. Keep only what would still help understand the user as a person if reviewed a year from now:
- Identity, personality traits, aesthetics, interests, and values.
- Long-term likes and dislikes.
- Long-term relationships and stable life background.
- Persistent long-term focus directions.

Remove one-off task details, work-style preferences, tool habits, validation order, report formats, and specific assistant outputs.

Keep it concise. Do not output Markdown headings.`;

const FACTS_PROMPT =
  "Deduplicate and merge key facts. Keep only stable user-profile facts: identity, traits, aesthetics, interests, likes/dislikes, long-term relationships, and long-term focus directions. Do not keep work style, collaboration process, tool preferences, or execution details. Prefer newer facts when conflicts exist. Keep the result within 200字以内. Do not output Markdown headings.";

export function buildCompileTodayPrompt(locale = "zh-CN") {
  return {
    templateVersion: "compile-today.v1",
    cacheGroup: "memory.compile.today",
    systemPrompt: TODAY_PROMPT + TODAY_ZH_CONTRACT,
  };
}

export function buildCompileWeekPrompt(locale = "zh-CN") {
  return {
    templateVersion: "compile-week.v1",
    cacheGroup: "memory.compile.week",
    systemPrompt: WEEK_PROMPT + WEEK_ZH_CONTRACT,
  };
}

export function buildCompileLongtermPrompt(locale = "zh-CN") {
  return {
    templateVersion: "compile-longterm.v1",
    cacheGroup: "memory.compile.longterm",
    systemPrompt: LONGTERM_PROMPT,
  };
}

export function buildCompileFactsPrompt(locale = "zh-CN") {
  return {
    templateVersion: "compile-facts.v1",
    cacheGroup: "memory.compile.facts",
    systemPrompt: FACTS_PROMPT,
  };
}
