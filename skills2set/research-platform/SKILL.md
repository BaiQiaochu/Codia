---
name: research-platform
description: Use when the user asks for structured research, source comparison, literature review, hypothesis generation, experiment planning, or synthesis that benefits from a repeatable research workflow and traceable evidence.
display-name:
  zh-CN: 资料研究
  en: Research Platform
short-description:
  zh-CN: 用可追溯证据完成资料检索、比较和综合。
  en: Conduct traceable research, comparison, and synthesis.
metadata:
  default-enabled: false
---

# Research Platform

Use this skill for research tasks that need evidence, comparison, and a clear chain from question to conclusion.

## Research Flow

1. Restate the research question and scope.
2. Split the work into search, extraction, comparison, and synthesis.
3. Prefer primary sources when accuracy matters.
4. Track claims separately from interpretations.
5. Call out uncertainty, missing evidence, and source limitations.
6. Produce concise conclusions with cited or locally traceable evidence.

## Output Shape

For short tasks, return a direct answer plus sources or file references. For larger tasks, return:

- question and scope;
- evidence table or source notes;
- synthesis;
- open questions;
- recommended next steps.

## Guardrails

- Do not overstate weak evidence.
- Do not invent citations.
- Separate facts, assumptions, and recommendations.
- Keep summaries short unless the user explicitly asks for a full report.
