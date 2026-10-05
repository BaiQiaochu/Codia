// @ts-nocheck
import crypto from "node:crypto";

export const name = "build-graph";
export const description =
  "从文本、笔记或对话中提取概念与关系，异步构建本地知识图谱，并返回可交互图谱卡片。";
export const promptSnippet =
  "当用户要生成、查看、更新知识图谱，或把笔记、文档、当前对话整理成概念关系网络时，调用 knowledge-graph_build-graph。";

export const parameters = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "用于构建知识图谱的文本内容，可以是笔记、文档片段、对话摘要或用户粘贴内容。",
    },
    documents: {
      type: "array",
      description: "可选。一次传入多份文档，适合把多段资料合并到同一张图谱。",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              text: { type: "string" },
            },
            required: ["text"],
          },
        ],
      },
    },
    title: {
      type: "string",
      description: "这批文本的标题或来源名称，可选。",
    },
    rebuild: {
      type: "boolean",
      description: "是否在构建前归档并替换当前图谱。默认 false。",
    },
    maxNodes: {
      type: "number",
      description: "本次最多提取多少个节点，默认 24，最大 80。",
    },
  },
  required: [],
};

function makeSourceId(title, text) {
  return crypto
    .createHash("sha1")
    .update(`${title || ""}\n${String(text || "").slice(0, 4096)}`)
    .digest("hex")
    .slice(0, 12);
}

function normalizeDocuments(inputDocuments) {
  if (!Array.isArray(inputDocuments)) return [];

  return inputDocuments
    .map((item, index) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return {
          id: `doc-${index + 1}`,
          title: `文档 ${index + 1}`,
          text,
        };
      }

      if (!item || typeof item !== "object") return null;
      const text = String(item.text ?? item.content ?? item.body ?? "").trim();
      if (!text) return null;
      return {
        id: String(item.id ?? item.sourceId ?? item.source_id ?? "").trim() || undefined,
        title: String(item.title ?? item.name ?? `文档 ${index + 1}`).trim(),
        text,
      };
    })
    .filter(Boolean);
}

export async function execute(input, ctx) {
  const store = ctx._knowledgeGraph?.store;
  const taskManager = ctx._knowledgeGraph?.taskManager;
  if (!store || !taskManager) {
    return { content: [{ type: "text", text: "知识图谱插件未初始化。" }] };
  }

  const text = String(input?.text || "").trim();
  const documents = normalizeDocuments(input?.documents);
  if (!text && documents.length === 0) {
    return { content: [{ type: "text", text: "请提供要构建知识图谱的文本内容。" }] };
  }

  const titleInput = String(input?.title || "").trim();
  const rebuild = Boolean(input?.rebuild);
  const maxNodes = input?.maxNodes;

  const submission = taskManager.submitBuildTask({
    title: titleInput,
    text,
    documents,
    rebuild,
    maxNodes,
    sourceId: makeSourceId(titleInput, text),
    archiveReason: rebuild ? "rebuild" : "incremental",
    parentSessionPath: ctx.sessionPath || "",
  });

  if (!submission.accepted) {
    return {
      content: [
        {
          type: "text",
          text: `已有知识图谱构建任务正在进行中，请稍后刷新图谱卡片查看进度。任务 ID: ${submission.task.id}`,
        },
      ],
      details: {
        card: {
          type: "iframe",
          route: "/card",
          title: "知识图谱",
          description: "构建任务仍在进行中",
          aspectRatio: "16:10",
        },
        knowledgeGraph: {
          taskId: submission.task.id,
          status: submission.task.status,
          progress: submission.task.progress,
        },
      },
    };
  }

  const title = titleInput ? `知识图谱：${titleInput.slice(0, 30)}` : "知识图谱";
  const description = rebuild ? "已提交重建任务，完成后会保留上一版归档。" : "已提交构建任务。";

  return {
    content: [
      {
        type: "text",
        text: `${description} 当前任务 ID: ${submission.task.id}。打开图谱卡片后会自动轮询进度，并在完成后显示结果。`,
      },
    ],
    details: {
      card: {
        type: "iframe",
        route: "/card",
        title,
        description,
        aspectRatio: "16:10",
      },
      knowledgeGraph: {
        taskId: submission.task.id,
        status: submission.task.status,
        progress: submission.task.progress,
      },
    },
  };
}
