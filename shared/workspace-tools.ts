export type WorkspaceToolId =
  | "research"
  | "documents"
  | "meeting"
  | "selection"
  | "workflow-market";

export type WorkspaceToolSelection = {
  id: WorkspaceToolId;
  title: string;
  description: string;
};

export type WorkspaceToolContract = WorkspaceToolSelection & {
  backendRoute: string | null;
  operation: string;
  capabilities: string[];
  recommendedTools: string[];
  systemInstruction: string;
};

const WORKSPACE_TOOL_DEFINITIONS: Record<WorkspaceToolId, WorkspaceToolContract> = {
  research: {
    id: "research",
    title: "研究模式",
    description: "引用溯源、可信度、可导出报告",
    backendRoute: "/api/prompts/research",
    operation: "research_mode",
    capabilities: ["web_search", "web_fetch", "citation_trace", "confidence_scoring", "export_outline"],
    recommendedTools: ["web_search", "web_fetch"],
    systemInstruction: [
      "Research Mode is active.",
      "When the user refers to this tool, they mean Research Mode.",
      "Use search/fetch capabilities for source-backed answers, include citations, confidence, timestamps, and export-ready report structure.",
    ].join(" "),
  },
  documents: {
    id: "documents",
    title: "文档工作台",
    description: "摘要、表格、PPT、大纲、对比",
    backendRoute: "/api/fs/preview",
    operation: "document_workspace",
    capabilities: ["document_summary", "table_extraction", "outline_generation", "comparison", "ppt_outline"],
    recommendedTools: ["current_status", "read", "stage_files"],
    systemInstruction: [
      "Document Workspace is active.",
      "When the user refers to this tool, they mean the document workbench.",
      "Use the current UI context, session files, and file-reading tools before answering. Produce summaries, tables, outlines, comparisons, or PPT-ready content as requested.",
    ].join(" "),
  },
  meeting: {
    id: "meeting",
    title: "会议纪要",
    description: "转写、摘要、行动项、风险项",
    backendRoute: "/api/speech-recognition/providers",
    operation: "meeting_minutes",
    capabilities: ["speech_recognition", "transcript_cleanup", "meeting_summary", "action_items", "risk_items"],
    recommendedTools: ["current_status", "read", "stage_files"],
    systemInstruction: [
      "Meeting Minutes mode is active.",
      "When the user refers to this tool, they mean meeting-note generation.",
      "If audio or transcript content is provided, organize it into transcript, summary, decisions, action items, owners, deadlines, and risks. Ask for an audio/transcript file only when none is available.",
    ].join(" "),
  },
  selection: {
    id: "selection",
    title: "划词助手",
    description: "解释、翻译、总结、加入知识库",
    backendRoute: "/api/resources",
    operation: "selection_assistant",
    capabilities: ["explain_selection", "translate_selection", "summarize_selection", "knowledge_capture"],
    recommendedTools: ["current_status", "read", "stage_files"],
    systemInstruction: [
      "Selection Assistant is active.",
      "When the user refers to this tool, they mean selected-text assistance.",
      "Use quoted selections or active document context first. Explain, translate, summarize, or prepare knowledge-base entries according to the user request.",
    ].join(" "),
  },
  "workflow-market": {
    id: "workflow-market",
    title: "工作流模板",
    description: "合同、研报、周报、质检模板",
    backendRoute: "/api/channels",
    operation: "workflow_templates",
    capabilities: ["workflow_template_selection", "workflow_plan_generation", "channel_workflow_link"],
    recommendedTools: ["workflow", "subagent", "current_status"],
    systemInstruction: [
      "Workflow Template mode is active.",
      "When the user refers to this tool, they mean workflow templates.",
      "Help the user choose or build a workflow template with nodes, inputs, outputs, retry rules, and channel/workflow integration points.",
    ].join(" "),
  },
};

export const WORKSPACE_TOOL_OPTIONS: readonly WorkspaceToolSelection[] = Object.freeze(
  Object.values(WORKSPACE_TOOL_DEFINITIONS).map(({ id, title, description }) => ({
    id,
    title,
    description,
  })),
);

export const WORKSPACE_TOOL_CONTRACTS: readonly WorkspaceToolContract[] = Object.freeze(
  Object.values(WORKSPACE_TOOL_DEFINITIONS).map((tool) => ({ ...tool })),
);

export function isWorkspaceToolId(value: unknown): value is WorkspaceToolId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WORKSPACE_TOOL_DEFINITIONS, value);
}

export function getWorkspaceToolContract(value: unknown): WorkspaceToolContract | null {
  const id = typeof value === "string"
    ? value.trim()
    : value && typeof value === "object" && "id" in value
      ? String((value as { id?: unknown }).id || "").trim()
      : "";
  if (!isWorkspaceToolId(id)) return null;
  return { ...WORKSPACE_TOOL_DEFINITIONS[id] };
}

export function normalizeWorkspaceToolSelection(value: unknown): WorkspaceToolSelection | null {
  const contract = getWorkspaceToolContract(value);
  if (!contract) return null;
  return {
    id: contract.id,
    title: contract.title,
    description: contract.description,
  };
}

export function buildWorkspaceToolTurnContext(value: unknown) {
  const contract = getWorkspaceToolContract(value);
  if (!contract) return null;
  return {
    system: [
      "<workspace-tool-contract>",
      `id: ${contract.id}`,
      `title: ${contract.title}`,
      `operation: ${contract.operation}`,
      `backend_route: ${contract.backendRoute || "none"}`,
      `capabilities: ${contract.capabilities.join(", ")}`,
      `recommended_tools: ${contract.recommendedTools.join(", ")}`,
      contract.systemInstruction,
      "This is a structured application tool mode, not user prose. Treat phrases like '这个工具', '当前工具', or 'this tool' as referring to this selected workspace tool.",
      "</workspace-tool-contract>",
    ].join("\n"),
    metadata: {
      source: "workspace-tool-contract",
      workspaceTool: {
        id: contract.id,
        title: contract.title,
        operation: contract.operation,
        backendRoute: contract.backendRoute,
        capabilities: contract.capabilities,
        recommendedTools: contract.recommendedTools,
      },
    },
  };
}
