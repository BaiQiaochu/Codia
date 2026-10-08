import React, { useEffect, useRef } from "react";
import { t, autoSaveConfig } from "../../helpers";
import { Toggle } from "../../widgets/Toggle";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsRow } from "../../components/SettingsRow";

// Local copy of OPTIONAL_TOOL_NAMES. Frontend intentionally does NOT import
// from shared/tool-categories.ts to keep the desktop bundle independent of
// node-only server code. Drift between this constant and the backend's
// shared/tool-categories.ts is caught by tests/optional-tool-names-drift.test.js
// (Task 10b) which imports both and asserts equality.
const OPTIONAL_TOOL_NAMES = [
  "automation",
  "beautify",
  "browser",
  "cron",
  "dm",
  "install_skill",
  "office",
  "update_settings",
  "workflow",
] as const;

const BUILTIN_INFO_TOOL_NAMES = [] as const;

const TOOL_COPY: Record<string, { label: string; summary: string }> = {
  automation: {
    label: "自动化",
    summary: "让 Agent 创建自动通知和定时插件动作",
  },
  beautify: {
    label: "文档美化",
    summary: "让 Agent 为文档生成封面和美化内容",
  },
  browser: {
    label: "浏览器",
    summary: "控制无头浏览器浏览网页",
  },
  cron: {
    label: "定时任务",
    summary: "在指定时间自动执行任务",
  },
  dm: {
    label: "私信",
    summary: "向其他 Agent 发送一对一消息",
  },
  install_skill: {
    label: "安装技能",
    summary: "从 GitHub 或技能库安装新技能",
  },
  office: {
    label: "Office 文档",
    summary: "让 Agent 读取文档、把 HTML 转换为 PDF",
  },
  update_settings: {
    label: "修改设置",
    summary: "让 Agent 修改应用配置项",
  },
  workflow: {
    label: "工作流",
    summary: "让 Agent 编排多智能体后台任务",
  },
};

type OptionalToolName = (typeof OPTIONAL_TOOL_NAMES)[number];
const OPTIONAL_TOOL_NAME_SET = new Set<string>(OPTIONAL_TOOL_NAMES);

function normalizeDisabledTools(disabled: string[]) {
  return (disabled || []).filter((name) => OPTIONAL_TOOL_NAME_SET.has(name));
}

function toolText(name: string, field: "label" | "summary") {
  const key = `settings.agent.tools.items.${name}.${field}`;
  const value = t(key);
  return value && value !== key ? value : (TOOL_COPY[name]?.[field] || name);
}

interface Props {
  availableTools?: string[];
  disabled?: string[];
}

export function AgentToolsSection({ availableTools, disabled }: Props) {
  // Toggle visual state is derived from the `disabled` prop (no useState),
  // but writes must be computed from the freshest known list, not the prop
  // captured at the previous render. Rapid-click-before-prop-refresh would
  // otherwise rebuild `newDisabled` from stale data and silently clobber the
  // earlier click. disabledRef tracks the latest known value (updated both
  // by prop sync below and optimistically after each toggleTool call) so
  // two consecutive toggles on different tools before the first PUT+GET
  // round-trip both survive.
  const normalizedDisabled = disabled ? normalizeDisabledTools(disabled) : undefined;
  const disabledRef = useRef(normalizedDisabled);
  useEffect(() => {
    disabledRef.current = normalizedDisabled;
  }, [normalizedDisabled]);

  const builtinInfoTools = Array.isArray(availableTools)
    ? BUILTIN_INFO_TOOL_NAMES.filter((name) => availableTools.includes(name))
    : [];

  // Only render rows for tools the agent actually has registered.
  // This naturally hides dm in single-agent environments where the agent
  // has no channelsDir/agentsDir wiring.
  const renderable = Array.isArray(availableTools)
    ? OPTIONAL_TOOL_NAMES.filter((name) => availableTools.includes(name))
    : [...OPTIONAL_TOOL_NAMES];

  const toggleTool = (name: OptionalToolName) => {
    if (!disabledRef.current) return;
    const current = disabledRef.current;
    const currentlyOff = current.includes(name);
    const newDisabled = currentlyOff
      ? current.filter((n) => n !== name)
      : [...current, name];
    disabledRef.current = newDisabled;
    autoSaveConfig({ tools: { disabled: newDisabled } });
  };

  if (renderable.length === 0 && builtinInfoTools.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      title={t("settings.agent.tools.title")}
      description={t("settings.agent.tools.description")}
    >
      {builtinInfoTools.length > 0 && (
        <>
          {builtinInfoTools.map((name) => (
            <SettingsRow
              key={name}
              data-tool-name={name}
              label={t(`settings.agent.tools.builtins.${name}.label`)}
              hint={t(`settings.agent.tools.builtins.${name}.summary`)}
              control={<span>{t("settings.agent.tools.builtinBadge")}</span>}
            />
          ))}
        </>
      )}
      {renderable.map((name) => {
        const isOn = normalizedDisabled ? !normalizedDisabled.includes(name) : undefined;
        return (
          <SettingsRow
            key={name}
            data-tool-name={name}
            label={toolText(name, "label")}
            hint={toolText(name, "summary")}
            control={<Toggle on={isOn} onChange={() => toggleTool(name)} />}
          />
        );
      })}
    </SettingsSection>
  );
}
