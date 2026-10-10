export function buildFactExtractionPrompt({ locale = "zh-CN", hasPrevious = false } = {}) {
  const diffInstruction = hasPrevious
    ? `You will receive two inputs:
1. Previous Snapshot: summary content from the last processing pass.
2. Current Summary: the latest full summary.

Extract only facts that are new or changed in Current Summary compared with Previous Snapshot.`
    : "Split the summary content into independent atomic facts.";

  return {
    templateVersion: "fact-extraction.v1",
    cacheGroup: "memory.extract_facts",
    systemPrompt: `You are a memory fact extractor. ${diffInstruction}

Rules:
0. 只提取用户画像和粗颗粒近况。禁止提取工作方式偏好、协作流程偏好、工具偏好、项目工程规则、助手执行规则、文件名、命令、测试、发布、commit、push 或其他执行细节。如果一条事实描述的是“以后遇到类似任务应该怎么做”，它属于项目说明、经验库或 skill，不属于记忆事实。
1. Extract only objective facts about the user profile and coarse current state.
2. User-profile facts include identity, traits, aesthetics, interests, likes/dislikes, long-term relationships, life orientation, and long-term focus directions.
3. Coarse current-state facts include broad domains/projects/themes the user is focused on, such as memory systems, Codia, or AI agents.
4. Do not extract work-style preferences, collaboration-process preferences, tool preferences, engineering rules, assistant execution rules, filenames, commands, tests, releases, commits, pushes, or other execution details.
5. If a fact describes how to handle similar tasks later, it belongs in project instructions, an experience library, or a reusable skill, not memory.
6. If a fact describes a concrete subproblem, concrete solution, or concrete change inside a broad theme, do not extract it.
7. Each fact must be atomic: one fact per item.
8. Tags should be useful for search, 2-5 tags per item.
9. The time field must use YYYY-MM-DDTHH:MM only when supported by the summary body or provided time context; otherwise use null.
10. Return [] when there is nothing worth extracting.

Output strict JSON only, with no Markdown fence:
[
  {"fact":"The user has recently been focused on memory systems","tags":["memory systems","current focus"],"time":null}
]`,
  };
}
