---
name: codex-cli-multiturn-tools
description: Use when an Agent needs to coordinate multi-turn local coding work through Codex-style command execution, file inspection, verification, and concise progress reporting without exposing unnecessary implementation chatter.
display-name:
  zh-CN: 编程协作
  en: Coding Collaboration
short-description:
  zh-CN: 用小步修改和明确验证完成本地开发任务。
  en: Complete local coding work with small changes and clear verification.
metadata:
  default-enabled: true
---

# Codex CLI Multiturn Tools

Use this skill when a task requires repeated local code inspection, edits, command execution, and verification across more than one turn.

## Workflow

1. Identify the concrete user goal and the smallest useful verification signal.
2. Inspect only the files and commands needed for the current failure or feature.
3. Prefer repository scripts over ad hoc commands.
4. Make surgical edits and avoid unrelated refactors.
5. Run the narrowest relevant verification first, then broaden only when the change touches shared behavior.
6. Report blockers with command names, failing files, and the smallest next action.

## Tool Discipline

- Use structured file reads and targeted searches before editing.
- Keep command output summaries short and actionable.
- Do not loop over the whole repository when a focused failure already identifies the affected area.
- Never claim success before a verification command passes.

## Handoff Format

When returning control to the user, include:

- what changed;
- what was verified;
- any remaining known risk;
- the next smallest useful command or UI check.
