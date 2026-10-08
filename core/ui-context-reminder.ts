/**
 * UI Context Reminder 注入
 *
 * 在每次 LLM 调用前（Pi SDK 的 `context` event hook），把用户当下 UI 视野
 * 的元信息拼成一段 `<user-context>...</user-context>` reminder，插入到
 * 最后一条 user message 的 content 开头。
 *
 * 关键特性（见 docs/superpowers/specs/2026-04-22-viewer-spawn-and-context-injection-design.md）：
 * - 只改 Pi SDK 传进来的 messages deep copy，不影响 `session.entries` 持久化
 * - 下一轮 hook 再触发时从最新 UI state 重拼，旧值自然丢弃（不累积）
 * - 躲在 system prompt 缓存断点之后、last user message 缓存断点之内，
 *   搭"本来每轮都要重建"的便车，零新增缓存成本
 *
 * 去冗余规则：
 * - `current_folder` 仅当 `currentViewed !== session.cwd` 时写
 *   （避免跟 agent.js 的 system prompt「书桌」章节重复）
 * - `active_file` 和 `active_artifact` 二选一（前者优先：有 filePath 走 active_file）
 * - `pinned_files` 空数组则省略整段
 * - 所有字段都空 → 返回 null，hook 啥也不改
 */
import { buildWorkspaceToolTurnContext } from "../shared/workspace-tools.ts";

function uiContextWithoutWorkspaceTool(uiCtx) {
  if (!uiCtx || typeof uiCtx !== "object") return uiCtx;
  const { workspaceTool: _workspaceTool, ...rest } = uiCtx;
  return rest;
}

/**
 * @typedef {Object} UiContext
 * @property {string|null} [currentViewed]  用户当前浏览的子目录（deskCurrentPath）
 * @property {string|null} [activeFile]     主面板 active tab 的 filePath（本地文件）
 * @property {string|null} [activeArtifact] 主面板 active tab 的 title（无 filePath 的 memory artifact）
 * @property {string[]} [pinnedFiles]       派生 viewer 窗口钉住的文件绝对路径列表
 */

/**
 * 根据 UI context 和 session cwd 拼成 reminder 字符串。
 *
 * @param {UiContext|null|undefined} uiCtx
 * @param {string|null|undefined} sessionCwd
 * @returns {string|null}  完整 reminder 文本（包含尾部两个换行），或 null 表示没内容
 */
function normalizeWorkspaceTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const id = typeof tool.id === "string" ? tool.id.trim() : "";
  const title = typeof tool.title === "string" ? tool.title.trim() : "";
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  if (!id || !title) return null;
  return { id, title, description };
}

export function buildUiContextReminder(uiCtx, sessionCwd) {
  if (!uiCtx) return null;
  const lines = [];

  if (uiCtx.currentViewed && uiCtx.currentViewed !== sessionCwd) {
    lines.push(`current_folder: ${uiCtx.currentViewed}`);
  }

  if (uiCtx.activeFile) {
    lines.push(`active_file: ${uiCtx.activeFile}`);
  } else if (uiCtx.activeArtifact) {
    lines.push(`active_artifact: "${uiCtx.activeArtifact}"（前文生成的文稿）`);
  }

  if (Array.isArray(uiCtx.pinnedFiles) && uiCtx.pinnedFiles.length > 0) {
    lines.push("pinned_files:");
    for (const p of uiCtx.pinnedFiles) lines.push(`  - ${p}`);
  }

  const workspaceTool = normalizeWorkspaceTool(uiCtx.workspaceTool);
  if (workspaceTool) {
    lines.push("selected_workspace_tool:");
    lines.push(`  id: ${workspaceTool.id}`);
    lines.push(`  title: ${workspaceTool.title}`);
    if (workspaceTool.description) lines.push(`  purpose: ${workspaceTool.description}`);
    lines.push("  instruction: The user selected this workspace tool for the current turn. Explain or act according to this tool when the user refers to 'this tool'.");
  }

  if (lines.length === 0) return null;
  return `<user-context>\n${lines.join("\n")}\n</user-context>\n\n`;
}

export function buildUiContextTurnContext(uiCtx, sessionCwd) {
  if (!uiCtx) return null;
  const visibleReminder = buildUiContextReminder(uiContextWithoutWorkspaceTool(uiCtx), sessionCwd);
  const workspaceToolContext = buildWorkspaceToolTurnContext(uiCtx.workspaceTool);
  const metadata = {
    source: workspaceToolContext ? "desktop-ui-context+workspace-tool" : "desktop-ui-context",
    ...(workspaceToolContext?.metadata?.workspaceTool
      ? { workspaceTool: workspaceToolContext.metadata.workspaceTool }
      : {}),
  };
  if (!visibleReminder && !workspaceToolContext?.system) return null;
  return {
    ...(workspaceToolContext?.system ? { system: workspaceToolContext.system } : {}),
    ...(visibleReminder ? { beforeUser: visibleReminder } : {}),
    metadata,
  };
}

/**
 * 把 reminder 前置到最后一条 user message 的内容开头。
 *
 * Pi SDK 的 `context` event 保证 messages 是 deep copy，所以就地修改安全，
 * 不影响 session.entries 持久化。
 *
 * content 可能是 string（简单文本）或 content block 数组（多模态）。
 * - string：直接前缀
 * - array 且有 text block：注入第一个 text block 开头
 * - array 但没 text block（例如只有 images）：开头插入一个 text block
 *
 * 无 user message 时为 no-op（防御性，正常场景不该发生）。
 *
 * @param {Array} messages  Pi SDK 的 messages 深拷贝
 * @param {string} reminder 已拼好的 `<user-context>…</user-context>\n\n` 文本
 * @returns {{ messages: Array }}  同一个 messages 引用（已就地修改）
 */
export function injectReminderIntoLastUserMessage(messages, reminder) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;

    if (typeof m.content === "string") {
      m.content = reminder + m.content;
    } else if (Array.isArray(m.content)) {
      const firstTextIdx = m.content.findIndex((b) => b?.type === "text");
      if (firstTextIdx >= 0) {
        m.content[firstTextIdx] = {
          ...m.content[firstTextIdx],
          text: reminder + (m.content[firstTextIdx].text ?? ""),
        };
      } else {
        m.content.unshift({ type: "text", text: reminder });
      }
    }
    break;
  }
  return { messages };
}
