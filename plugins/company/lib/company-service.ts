// @ts-nocheck
import crypto from "node:crypto";
import path from "node:path";
import { createCompanyStore } from "./company-store.ts";

export const DEFAULT_COMPANY_ID = "company_default";

const DEFAULT_EMPLOYEES = [
  {
    id: "project_manager",
    role: "project_manager",
    title: "项目经理",
    name: "项目经理",
    capability: "拆任务、派工、追进度、总结。",
    training: "识别老板命令，拆成任务卡，按角色派发，持续追踪交付状态。",
    agentAliases: ["pm", "project_manager", "project-manager", "项目经理"],
  },
  {
    id: "writer",
    role: "writer",
    title: "策划/编剧",
    name: "策划/编剧",
    capability: "需求拆解、脚本、方案、旁白和分镜文本。",
    training: "把业务需求转成可拍摄脚本、分镜说明和明确的提示词。",
    agentAliases: ["writer", "scriptwriter", "策划", "编剧", "策划/编剧"],
  },
  {
    id: "visual_designer",
    role: "visual_designer",
    title: "视觉设计",
    name: "视觉设计",
    capability: "图片、分镜、风格资产、角色图和场景图。",
    training: "维护角色一致性和风格一致性，输出可复用视觉资产。",
    agentAliases: ["visual", "designer", "visual_designer", "视觉", "视觉设计"],
  },
  {
    id: "video_producer",
    role: "video_producer",
    title: "视频制作",
    name: "视频制作",
    capability: "图生视频、转场、剪辑和成片输出。",
    training: "把关键帧、参考图和提示词转成镜头级视频产物。",
    agentAliases: ["video", "video_producer", "video-producer", "视频", "视频制作"],
  },
  {
    id: "ops_qc",
    role: "ops_qc",
    title: "运营/质检",
    name: "运营/质检",
    capability: "发布文案、检查、客户沟通和交付验收。",
    training: "检查缺失素材、失败节点、未确认素材，整理客户可读交付说明。",
    agentAliases: ["ops", "qc", "ops_qc", "运营", "质检", "运营/质检"],
  },
];

const ROLE_LABELS = new Map(DEFAULT_EMPLOYEES.map((employee) => [employee.role, employee.title]));
ROLE_LABELS.set("admin", "管理员");
ROLE_LABELS.set("worker", "工人");

const CHANNEL_ROLE_PROFILES = {
  project_manager: {
    id: "project_manager",
    role: "project_manager",
    title: "项目经理",
    name: "项目经理",
  },
  admin: {
    id: "admin",
    role: "admin",
    title: "管理员",
    name: "管理员",
  },
  worker: {
    id: "worker",
    role: "worker",
    title: "工人",
    name: "工人",
  },
};

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function cleanText(value) {
  return String(value || "").trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function summarize(text, max = 48) {
  const value = cleanText(text).replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

async function listAgents(ctx) {
  try {
    const result = await ctx.bus?.request?.("agent:list", {});
    return Array.isArray(result?.agents) ? result.agents : [];
  } catch {
    return [];
  }
}

function bindEmployeeAgents(employees, agents) {
  const normalizedAgents = agents.map((agent) => ({
    ...agent,
    keys: [agent.id, agent.name].map((value) => cleanText(value).toLowerCase()).filter(Boolean),
  }));
  return employees.map((employee) => {
    const aliases = employee.agentAliases.map((value) => cleanText(value).toLowerCase());
    const match = normalizedAgents.find((agent) => agent.keys.some((key) => aliases.includes(key)));
    return {
      ...employee,
      status: "ready",
      agentId: match?.id || employee.agentId || "",
      agentName: match?.name || employee.agentName || "",
    };
  });
}

function roleFromAssignee(company, assignee) {
  const text = cleanText(assignee).toLowerCase();
  if (!text) return "";
  const employee = company.employees.find((item) =>
    item.role === text
    || item.id === text
    || cleanText(item.title).toLowerCase() === text
    || cleanText(item.name).toLowerCase() === text
    || cleanText(item.agentId).toLowerCase() === text);
  return employee?.role || "";
}

function rolesForCommand(text, assigneeRole = "") {
  const command = cleanText(text);
  const roles = ["project_manager"];
  if (assigneeRole && assigneeRole !== "project_manager") roles.push(assigneeRole);
  if (/脚本|剧本|策划|编剧|方案|需求|文本|旁白|分镜文本/i.test(command)) roles.push("writer");
  if (/视觉|图片|图像|关键帧|分镜|角色|场景|风格|海报|参考图/i.test(command)) roles.push("visual_designer");
  if (/视频|图生视频|剪辑|成片|转场|镜头|短片|片段/i.test(command)) roles.push("video_producer");
  if (/发布|质检|检查|运营|沟通|客户沟通|验收|文案/i.test(command)) roles.push("ops_qc");
  return unique(roles);
}

function channelHasRole(channelInfo, role) {
  const memberRoles = channelInfo?.memberRoles || {};
  return Object.values(memberRoles).includes(role);
}

function channelRoleFromAnyRole(role) {
  const value = cleanText(role);
  if (value === "project_manager" || value === "admin" || value === "worker") return value;
  if (value === "ops_qc") return "admin";
  if (["writer", "visual_designer", "video_producer"].includes(value)) return "worker";
  return "";
}

function rolesForChannelCommand(text, assigneeRole, channelInfo) {
  const command = cleanText(text);
  if (channelInfo) {
    const roles = ["project_manager"];
    const explicitChannelRole = channelRoleFromAnyRole(assigneeRole);
    if (explicitChannelRole && explicitChannelRole !== "project_manager") roles.push(explicitChannelRole);

    const projectLike =
      roles.length === 1 ||
      /项目|工程|实现|开发|修复|清理|融合|打包|任务|分派|协作|集群|agent|AI|workflow|工作流/i.test(command);
    const reviewLike = /复核|审核|验收|检查|质检|风险|汇总|进度|阻塞|失败|重试|发布/i.test(command);
    const executionLike = /执行|生成|制作|修改|处理|输出|图片|视频|文件|表格|代码|文档|实现|修复/i.test(command);

    if (channelHasRole(channelInfo, "admin") && (projectLike || reviewLike || !channelHasRole(channelInfo, "worker"))) {
      roles.push("admin");
    }
    if (channelHasRole(channelInfo, "worker") && (projectLike || executionLike || roles.length === 1)) {
      roles.push("worker");
    }
    return unique(roles);
  }

  const roles = rolesForCommand(command, assigneeRole);
  return unique(roles);
}

function defaultCriteriaForRole(role) {
  if (role === "project_manager") return ["拆解任务卡", "明确负责人和验收标准", "同步整体进度"];
  if (role === "admin") return ["复核任务状态和输出", "记录阻塞与失败原因", "汇总可交付结果"];
  if (role === "worker") return ["执行被分派任务", "输出可复用产物或明确结果", "按要求回报进度和风险"];
  if (role === "writer") return ["输出可执行脚本或方案", "标注关键镜头/旁白/提示词", "内容可直接交给视觉与视频环节"];
  if (role === "visual_designer") return ["输出可复用视觉资产", "保持角色与风格一致", "记录参考图和模型参数"];
  if (role === "video_producer") return ["收集首帧/尾帧/参考图", "提交图生视频或剪辑任务", "产物可被后续合成复用"];
  return ["检查缺失素材和失败任务", "输出发布/客户沟通文案", "标记未确认素材和风险"];
}

function taskForRole(company, role, input, extra = {}) {
  const timestamp = nowIso();
  const employee = company.employees.find((item) => item.role === role) || CHANNEL_ROLE_PROFILES[role] || {};
  const command = cleanText(input.command || input.description || input.title);
  const criteria = safeArray(input.acceptanceCriteria).map(cleanText).filter(Boolean);
  return {
    id: id("task"),
    companyId: company.id,
    channelId: cleanText(input.channelId),
    sourceMessageId: cleanText(input.sourceMessageId),
    title: `${ROLE_LABELS.get(role) || role}任务：${summarize(input.title || command || "待处理工作")}`,
    description: command,
    assigneeEmployeeId: employee.id || role,
    assigneeRole: role,
    assigneeTitle: employee.title || role,
    assigneeAgentId: employee.agentId || "",
    dueAt: cleanText(input.dueAt),
    acceptanceCriteria: criteria.length ? criteria : defaultCriteriaForRole(role),
    requireAcceptance: input.requireAcceptance === true,
    outputFormat: cleanText(input.outputFormat),
    writePaths: safeArray(input.writePaths).map(cleanText).filter(Boolean).map(value => path.posix.normalize(value.replaceAll("\\", "/"))),
    status: "assigned",
    priority: cleanText(input.priority) || "normal",
    source: input.source || { type: "company_command" },
    mentions: unique([employee.agentId ? `@${employee.agentId}` : "", `@${employee.title || role}`]),
    artifacts: [],
    report: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

const TASK_STATUS_VALUES = new Set(["assigned", "in_progress", "reported", "completed", "blocked", "failed", "queued", "awaiting_approval", "cancelled"]);

function normalizeTaskStatus(value, fallback = "reported") {
  const status = cleanText(value);
  return TASK_STATUS_VALUES.has(status) ? status : fallback;
}

function taskMatchesChannel(task, channelId) {
  const idValue = cleanText(channelId);
  if (!idValue) return true;
  return !task.channelId || cleanText(task.channelId) === idValue;
}

function taskMatchesTitle(task, title) {
  const titleValue = cleanText(title).toLowerCase();
  if (!titleValue) return true;
  const haystack = [
    task.id,
    task.title,
    task.description,
    task.assigneeTitle,
  ].map((value) => cleanText(value).toLowerCase()).join("\n");
  return haystack.includes(titleValue);
}

function latestTaskSortValue(task) {
  return cleanText(task.updatedAt || task.createdAt || "");
}

function findReportTargetTask(tasks, input = {}) {
  const taskId = cleanText(input.taskId);
  if (taskId) return tasks.find((task) => task.id === taskId) || null;

  const channelId = cleanText(input.channelId);
  const agentId = cleanText(input.agentId || input.assigneeAgentId || input.senderId);
  const taskTitle = cleanText(input.taskTitle || input.title);
  const activeStatuses = new Set(["assigned", "in_progress", "reported", "blocked", "awaiting_approval"]);

  const candidates = tasks
    .filter((task) => taskMatchesChannel(task, channelId))
    .filter((task) => !agentId || cleanText(task.assigneeAgentId) === agentId)
    .filter((task) => taskMatchesTitle(task, taskTitle))
    .filter((task) => activeStatuses.has(cleanText(task.status) || "assigned"))
    .sort((a, b) => latestTaskSortValue(b).localeCompare(latestTaskSortValue(a)));

  return candidates[0] || null;
}

function normalizePlatform(value) {
  const platform = cleanText(value).toLowerCase();
  if (["telegram", "tg"].includes(platform)) return "telegram";
  if (["feishu", "lark", "飞书"].includes(platform)) return "feishu";
  if (["qq"].includes(platform)) return "qq";
  return platform || "internal";
}

function isBossCommand(input = {}) {
  if (input.isBoss === true) return true;
  const text = cleanText(input.text || input.command);
  return /^\/boss\b/i.test(text) || text.includes("@项目经理") || /^老板[:：]/.test(text);
}

function channelReplyForTasks(tasks) {
  if (!tasks.length) return "";
  return [
    `项目经理已拆分 ${tasks.length} 个任务：`,
    ...tasks.map((task) => `- ${task.assigneeTitle}: ${task.title}`),
  ].join("\n");
}

function externalDeliveryTarget(channel) {
  if (!channel?.mirrorToExternal) return null;
  if (channel.platform === "internal") return null;
  if (!channel.externalGroupId) return null;
  return {
    platform: channel.platform,
    externalGroupId: channel.externalGroupId,
  };
}

function statusSummary(company, channels, tasks) {
  const byStatus = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  return {
    companyId: company.id,
    employeeCount: company.employees.length,
    channelCount: channels.length,
    taskCount: tasks.length,
    byStatus,
  };
}

function companyRoleToChannelRole(role) {
  if (role === "project_manager") return "project_manager";
  if (role === "admin") return "admin";
  if (role === "worker") return "worker";
  if (role === "ops_qc") return "admin";
  return "worker";
}

function workflowRole(value) {
  const role = cleanText(value);
  if (["project_manager", "admin", "worker", "writer", "visual_designer", "video_producer", "ops_qc"].includes(role)) return role;
  return "";
}

function companyRoleFromChannelRole(role) {
  if (role === "project_manager") return "project_manager";
  if (role === "admin") return "admin";
  if (role === "worker") return "worker";
  return "";
}

function firstMemberByRole(channelInfo, role) {
  const memberRoles = channelInfo?.memberRoles || {};
  const members = Array.isArray(channelInfo?.members) ? channelInfo.members : [];
  return members.find((memberId) => memberRoles[memberId] === role) || "";
}

function fallbackChannelMember(channelInfo) {
  const members = Array.isArray(channelInfo?.members) ? channelInfo.members : [];
  return firstMemberByRole(channelInfo, "worker")
    || firstMemberByRole(channelInfo, "admin")
    || firstMemberByRole(channelInfo, "project_manager")
    || members[0]
    || "";
}

function channelSupervisorAgentIds(channelInfo) {
  const members = Array.isArray(channelInfo?.members) ? channelInfo.members : [];
  const memberRoles = channelInfo?.memberRoles || {};
  return unique(members.filter((memberId) => (
    memberRoles[memberId] === "project_manager" || memberRoles[memberId] === "admin"
  )));
}

function channelAssigneeForRole(role, channelInfo) {
  if (!channelInfo) return "";
  const preferred = companyRoleToChannelRole(role);
  if (preferred === "project_manager") {
    return firstMemberByRole(channelInfo, "project_manager") || fallbackChannelMember(channelInfo);
  }
  if (preferred === "admin") {
    return firstMemberByRole(channelInfo, "admin")
      || firstMemberByRole(channelInfo, "worker")
      || fallbackChannelMember(channelInfo);
  }
  return firstMemberByRole(channelInfo, "worker")
    || firstMemberByRole(channelInfo, "admin")
    || fallbackChannelMember(channelInfo);
}

function agentNameFromChannel(channelInfo, agentId) {
  const agents = Array.isArray(channelInfo?.agents) ? channelInfo.agents : [];
  return agents.find((agent) => agent.id === agentId)?.name || "";
}

function workflowItemKey(item, index) {
  return cleanText(item?.id || item?.nodeId || item?.itemId) || `workflow_node_${index + 1}`;
}

function workflowNodeRole(item, channelInfo) {
  const explicit = workflowRole(item?.assigneeRole || item?.role);
  if (explicit) return explicit;
  const agentId = cleanText(item?.assigneeAgentId || item?.agentId);
  const channelRole = agentId ? channelInfo?.memberRoles?.[agentId] : "";
  return companyRoleFromChannelRole(channelRole) || (channelInfo ? "worker" : "writer");
}

function bindTasksToChannelMembers(tasks, channelInfo) {
  if (!channelInfo) return tasks;
  const members = new Set(Array.isArray(channelInfo.members) ? channelInfo.members : []);
  return tasks.map((task) => {
    const currentAssignee = cleanText(task.assigneeAgentId);
    const assigneeAgentId = currentAssignee && members.has(currentAssignee)
      ? currentAssignee
      : channelAssigneeForRole(task.assigneeRole, channelInfo);
    if (!assigneeAgentId) return task;
    return {
      ...task,
      assigneeAgentId,
      assigneeAgentName: agentNameFromChannel(channelInfo, assigneeAgentId) || task.assigneeAgentName || "",
      mentions: unique([`@${assigneeAgentId}`, ...safeArray(task.mentions)]),
    };
  });
}

function formatChannelTaskDispatch(tasks) {
  if (!tasks.length) return "";
  return [
    `公司任务已分派 ${tasks.length} 项：`,
    ...tasks.map((task) => {
      const mention = task.assigneeAgentId ? `@${task.assigneeAgentId}` : task.assigneeTitle;
      return [
        `- ${mention}：${task.title} (taskId: ${task.id})`,
        `  输入：${task.description}`,
        `  验收：${safeArray(task.acceptanceCriteria).join("；")}`,
        task.outputFormat ? `  交付格式：${task.outputFormat}` : "",
        task.writePaths?.length ? `  声明写入范围：${task.writePaths.join("、")}` : "",
        task.requireAcceptance ? "  完成时必须通过 report 工具提交逐项 acceptanceResults（criterion、passed、evidence），并附结果或产物引用。" : "  请通过 report 工具回报真实状态和结果；派发不代表完成。",
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

export function createCompanyService(ctx) {
  // Cancel intent is synchronous, including while assignment is awaiting I/O.
  const cancelledRuns = new Set();
  const runDispatches = new Map();
  const runAssignments = new Map();
  const companyKey = value => !cleanText(value) || cleanText(value) === "default" ? DEFAULT_COMPANY_ID : cleanText(value);
  const runKey = (companyId, runId) => `${companyKey(companyId)}:${runId}`;
  function dispatchWorkflowRun(companyId, runId) {
    const key = runKey(companyId, runId);
    const previous = runDispatches.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const tasks = (await store.listTasks(companyId)).filter(task => task.source?.runId === runId);
      if (cancelledRuns.has(key) || tasks.some(task => task.status === "cancelled")) return;
      const byId = new Map(tasks.map(task => [task.id, task]));
      // Propagate failures in any canvas node order, including long chains.
      let changed = true;
      while (changed && !cancelledRuns.has(key)) {
        changed = false;
        for (const task of tasks) {
          if (task.status === "queued" && safeArray(task.dependsOn).some(id => byId.get(id)?.status === "failed")) {
            await store.updateTask(task.id, { status: "failed", report: "Dependency failed; step was not dispatched" });
            task.status = "failed";
            changed = true;
          }
        }
      }
      for (const task of tasks) {
        if (cancelledRuns.has(key)) return;
        if (task.status !== "queued") continue;
        const dependencies = safeArray(task.dependsOn).map(id => byId.get(id));
        if (dependencies.some(dep => dep?.status === "failed")) {
          await store.updateTask(task.id, { status: "failed", report: "Dependency failed; step was not dispatched" });
          task.status = "failed";
          continue;
        }
        if (!dependencies.every(dep => dep?.status === "completed")) continue;
        // Persist before external dispatch: uncertain deliveries are never auto-replayed.
        const assigned = await store.updateTask(task.id, { status: "assigned" });
        if (cancelledRuns.has(key)) return;
        try {
          await postAssignedTasksToChannel([{ ...assigned, description: [assigned.description,
            ...dependencies.map(dep => `已完成依赖 ${dep.id}: ${dep.report || ""} ${JSON.stringify(dep.artifacts || [])}`),
          ].join("\n") }], {
            dispatchChannelId: task.source.dispatchChannelId,
            strictDispatch: true,
          });
        } catch (error) {
          if (cancelledRuns.has(key)) return;
          await store.updateTask(task.id, { status: "blocked", dispatchOutcome: "unknown", report: `Dispatch outcome unknown; inspect external results before retry: ${error.message}` });
          task.status = "blocked";
        }
      }
    });
    runDispatches.set(key, next);
    return next.finally(() => { if (runDispatches.get(key) === next) runDispatches.delete(key); });
  }

  async function cancelWorkflowRun(input = {}) {
    const runId = cleanText(input.runId);
    if (!runId) throw Object.assign(new Error("runId is required"), { status: 400 });
    cancelledRuns.add(runKey(input.companyId, runId));
    const company = await ensureCompany(input.companyId);
    const taskIds = new Set(safeArray(input.taskIds));
    const tasks = (await store.listTasks(company.id)).filter(task => task.source?.runId === runId || taskIds.has(task.id));
    for (const task of tasks) {
      if (!["completed", "failed", "cancelled"].includes(task.status)) {
        await store.updateTask(task.id, { status: "cancelled", report: "Cancelled; already-dispatched operations may finish" });
      }
    }
    return { runId, status: "cancelled" };
  }

  const store = ctx._company?.store || createCompanyStore(ctx.dataDir);
  if (ctx._company) ctx._company.store = store;

  async function requestChannelMembers(channelId) {
    const idValue = cleanText(channelId);
    if (!idValue || typeof ctx.bus?.request !== "function") return null;
    try {
      return await ctx.bus.request("channel:members", { channelId: idValue });
    } catch {
      return null;
    }
  }

  async function resolveLinkedChannel(channelId) {
    const idValue = cleanText(channelId);
    if (!idValue) return { channelId: "", info: null, sourceChannel: null };

    const direct = await requestChannelMembers(idValue);
    if (direct) return { channelId: idValue, info: direct, sourceChannel: null };

    const sourceChannel = await store.getChannel(idValue);
    const internalChannelId = cleanText(sourceChannel?.internalChannelId);
    if (internalChannelId && internalChannelId !== idValue) {
      const linked = await requestChannelMembers(internalChannelId);
      if (linked) {
        return { channelId: internalChannelId, info: linked, sourceChannel };
      }
    }

    return { channelId: idValue, info: null, sourceChannel };
  }

  async function ensureInternalChannelBinding(company, requestedChannelId, linkedChannel) {
    const internalChannelId = cleanText(linkedChannel?.channelId || requestedChannelId);
    if (!company?.id || !internalChannelId || !linkedChannel?.info) return null;
    if (linkedChannel.sourceChannel) return linkedChannel.sourceChannel;

    const existing = await store.getChannel(internalChannelId);
    const timestamp = nowIso();
    const channel = {
      id: existing?.id || internalChannelId,
      companyId: company.id,
      platform: existing?.platform || "internal",
      externalGroupId: existing?.externalGroupId || "",
      externalTitle: existing?.externalTitle || internalChannelId,
      internalChannelId: existing?.internalChannelId || internalChannelId,
      mirrorToExternal: existing?.platform && existing.platform !== "internal"
        ? existing.mirrorToExternal !== false
        : false,
      status: existing?.status || "connected",
      truth: existing?.truth || { messages: [] },
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    return store.upsertChannel(channel);
  }

  async function postAssignedTasksToChannel(tasks, input = {}, channelInfo = null) {
    const channelId = cleanText(input.dispatchChannelId || input.channelId);
    if (!channelId || !tasks.length || typeof ctx.bus?.request !== "function") {
      if (input.strictDispatch) throw new Error("Channel dispatch unavailable");
      return null;
    }
    const supervisorAgentIds = unique([
      ...channelSupervisorAgentIds(channelInfo),
      ...safeArray(input.supervisorAgentIds).map((agentId) => cleanText(agentId)),
    ]).filter(Boolean);
    const body = [
      formatChannelTaskDispatch(tasks),
      supervisorAgentIds.length > 0 ? `总监群监督：${supervisorAgentIds.map((agentId) => `@${agentId}`).join("、")}` : "",
    ].filter(Boolean).join("\n\n");
    if (!body) return null;
    const mentionedAgents = unique([
      ...tasks.map((task) => cleanText(task.assigneeAgentId)),
      ...supervisorAgentIds,
    ]);
    const pmTask = tasks.find((task) => task.assigneeRole === "project_manager") || tasks[0];
    try {
      const result = await ctx.bus.request("channel:post-message", {
        channelId,
        senderId: pmTask.assigneeAgentId || "project_manager",
        senderName: "项目经理",
        body,
        mentionedAgents,
        triggerDelivery: true,
        source: {
          type: "company_task_assigned",
          companyId: tasks[0]?.companyId,
        },
      });
      if (input.strictDispatch && result?.ok === false) throw new Error(result.error || "Channel rejected dispatch");
      return result;
    } catch (err) {
      if (input.strictDispatch) throw err;
      ctx.log?.warn?.(`company channel post failed: ${err?.message || String(err)}`);
      return null;
    }
  }

  function emitAssignedTasks(tasks) {
    for (const task of tasks) {
      try {
        ctx.bus?.emit?.({
          type: "company_task_assigned",
          companyId: task.companyId,
          taskId: task.id,
          channelId: task.channelId || null,
          assigneeRole: task.assigneeRole,
          assigneeAgentId: task.assigneeAgentId || null,
          task,
        }, null);
      } catch {
        // Task persistence is authoritative; event delivery is best-effort.
      }
    }
  }

  async function mirrorChannelText(channel, text, input = {}) {
    const target = externalDeliveryTarget(channel);
    if (!target) {
      return {
        status: "skipped",
        reason: "external mirror disabled",
        platform: channel?.platform || "internal",
        externalGroupId: channel?.externalGroupId || "",
      };
    }
    const delivery = {
      status: "queued",
      platform: target.platform,
      externalGroupId: target.externalGroupId,
      createdAt: nowIso(),
    };
    if (!ctx.bus?.request) {
      return { ...delivery, error: "bridge bus unavailable" };
    }
    if (typeof ctx.bus.hasHandler === "function" && !ctx.bus.hasHandler("bridge:send-text")) {
      return { ...delivery, error: "bridge text sender unavailable" };
    }
    try {
      const result = await ctx.bus.request("bridge:send-text", {
        platform: target.platform,
        chatId: target.externalGroupId,
        text,
        agentId: cleanText(input.agentId || input.senderId),
        channelId: channel.id,
        companyId: channel.companyId,
        replyContext: input.replyContext || null,
      });
      return {
        ...delivery,
        status: "sent",
        sentAt: nowIso(),
        result: result && typeof result === "object" ? result : {},
      };
    } catch (err) {
      return { ...delivery, error: err?.message || String(err) };
    }
  }

  async function createDefaultCompany(input = {}) {
    const timestamp = nowIso();
    const agents = await listAgents(ctx);
    const existing = await store.getCompany(DEFAULT_COMPANY_ID);
    const employees = bindEmployeeAgents(DEFAULT_EMPLOYEES, agents);
    const company = {
      id: DEFAULT_COMPANY_ID,
      name: cleanText(input.name) || existing?.name || "成品一人公司",
      ownerAlias: cleanText(input.ownerAlias) || existing?.ownerAlias || "老板",
      employees,
      orgChart: {
        project_manager: ["writer", "visual_designer", "video_producer", "ops_qc"],
      },
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    return store.upsertCompany(company);
  }

  async function ensureCompany(companyId) {
    const idValue = companyKey(companyId);
    return (await store.getCompany(idValue)) || createDefaultCompany({ id: idValue });
  }

  async function bindChannel(input = {}) {
    const company = await ensureCompany(input.companyId);
    const timestamp = nowIso();
    const platform = normalizePlatform(input.platform);
    const externalGroupId = cleanText(input.externalGroupId || input.groupId || input.chatId);
    const existing = externalGroupId ? await store.findChannelByExternal(platform, externalGroupId) : null;
    const channel = {
      id: existing?.id || cleanText(input.channelId) || id("ch"),
      companyId: company.id,
      platform,
      externalGroupId,
      externalTitle: cleanText(input.externalTitle || input.title || input.name),
      internalChannelId: cleanText(input.internalChannelId) || existing?.internalChannelId || `company_${company.id}`,
      mirrorToExternal: input.mirrorToExternal !== false,
      status: cleanText(input.status) || existing?.status || "connected",
      truth: existing?.truth || { messages: [] },
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    return store.upsertChannel(channel);
  }

  async function assignCommand(input = {}) {
    const company = await ensureCompany(input.companyId);
    const explicitRole = cleanText(input.assigneeRole) || roleFromAssignee(company, input.assignee);
    const linkedChannel = await resolveLinkedChannel(input.channelId);
    const channelInfo = linkedChannel.info;
    await ensureInternalChannelBinding(company, input.channelId, linkedChannel);
    const roles = rolesForChannelCommand(input.command || input.description || input.title, explicitRole, channelInfo);
    const supervisorAgentIds = channelSupervisorAgentIds(channelInfo);
    const source = input.source && typeof input.source === "object"
      ? input.source
      : { type: "company_command" };
    const taskInput = {
      ...input,
      source: {
        ...source,
        supervision: {
          mode: "director_group",
          supervisorAgentIds,
        },
      },
    };
    const treeId = id("tree");
    const rawTasks = roles.map((role) => taskForRole(company, role, taskInput, { treeId }));
    const rootTask = rawTasks.find((task) => task.assigneeRole === "project_manager") || rawTasks[0];
    const tasks = bindTasksToChannelMembers(
      rawTasks.map((task) => {
        const isRoot = task.id === rootTask.id;
        return {
          ...task,
          treeId,
          parentTaskId: isRoot ? "" : rootTask.id,
          dependsOn: isRoot ? [] : [rootTask.id],
          taskKind: isRoot ? "root" : "agent_task",
          depth: isRoot ? 0 : 1,
        };
      }),
      channelInfo,
    );
    const created = await store.addTasks(tasks);
    emitAssignedTasks(created);
    await postAssignedTasksToChannel(created, {
      ...input,
      dispatchChannelId: linkedChannel.channelId,
      supervisorAgentIds,
    }, channelInfo);
    return created;
  }

  async function ingestChannelMessage(channelId, input = {}) {
    const channel = await store.getChannel(channelId);
    if (!channel) {
      const err = new Error("channel not found");
      err.status = 404;
      throw err;
    }
    const timestamp = nowIso();
    const message = {
      truthId: id("msg"),
      channelId: channel.id,
      platform: channel.platform,
      externalGroupId: channel.externalGroupId,
      senderId: cleanText(input.senderId),
      senderName: cleanText(input.senderName) || "外部成员",
      text: cleanText(input.text || input.command),
      isBoss: input.isBoss === true,
      createdAt: timestamp,
    };
    await store.appendChannelMessage(channel.id, message);
    const createdTasks = isBossCommand(input)
      ? await assignCommand({
          companyId: channel.companyId,
          channelId: channel.id,
          sourceMessageId: message.truthId,
          command: message.text,
          source: { type: "social_channel", platform: channel.platform, externalGroupId: channel.externalGroupId },
        })
      : [];
    if (createdTasks.length) {
      const text = channelReplyForTasks(createdTasks);
      const company = await store.getCompany(channel.companyId);
      const delivery = await mirrorChannelText(channel, text, {
        senderId: "project_manager",
        agentId: company?.employees?.find?.((item) => item.role === "project_manager")?.agentId || "",
        replyContext: input.replyContext || null,
      });
      await store.appendChannelMessage(channel.id, {
        truthId: id("msg"),
        channelId: channel.id,
        platform: "internal",
        senderId: "project_manager",
        senderName: "项目经理",
        text,
        isBoss: false,
        delivery,
        createdAt: nowIso(),
      });
    }
    return { message, createdTasks };
  }

  async function postChannelReply(channelId, input = {}) {
    const channel = await store.getChannel(channelId);
    if (!channel) {
      const err = new Error("channel not found");
      err.status = 404;
      throw err;
    }
    const timestamp = nowIso();
    const text = cleanText(input.text || input.content || input.report);
    if (!text) {
      const err = new Error("reply text is required");
      err.status = 400;
      throw err;
    }
    const delivery = input.mirrorToExternal === false
      ? { status: "skipped", reason: "request disabled mirror", platform: channel.platform, externalGroupId: channel.externalGroupId }
      : await mirrorChannelText(channel, text, input);
    const message = {
      truthId: id("msg"),
      channelId: channel.id,
      platform: "internal",
      senderId: cleanText(input.senderId || input.agentId),
      senderName: cleanText(input.senderName) || "内部员工",
      text,
      isBoss: false,
      taskId: cleanText(input.taskId),
      delivery,
      createdAt: timestamp,
    };
    let updatedChannel = await store.appendChannelMessage(channel.id, message);
    if (delivery.status === "sent") {
      updatedChannel = await store.updateChannel(channel.id, {
        status: "connected",
        lastMirroredAt: delivery.sentAt,
        lastMirrorError: "",
      });
    } else if (delivery.status === "queued") {
      updatedChannel = await store.updateChannel(channel.id, {
        lastMirrorError: delivery.error || "queued",
      });
    }
    return { message, channel: updatedChannel };
  }

  async function updateChannelStatus(channelId, input = {}) {
    const status = cleanText(input.status);
    if (!status) {
      const err = new Error("status is required");
      err.status = 400;
      throw err;
    }
    const channel = await store.updateChannel(channelId, {
      status,
      statusReason: cleanText(input.reason || input.error),
      lastStatusAt: nowIso(),
    });
    if (!channel) {
      const err = new Error("channel not found");
      err.status = 404;
      throw err;
    }
    return channel;
  }

  async function reportTask(input = {}) {
    const company = await ensureCompany(input.companyId);
    const tasks = await store.listTasks(company.id);
    const target = findReportTargetTask(tasks, input);
    if (!target) {
      const err = new Error("company task not found for this channel and agent");
      err.status = 404;
      throw err;
    }

    if (target.status === "cancelled") return target;
    if (target.source?.runId && (cancelledRuns.has(runKey(company.id, target.source.runId)) || ["cancelled", "completed", "failed"].includes(target.status))) return target;
    if (target.source?.runId && target.status === "queued") throw Object.assign(new Error("Task is waiting for dependencies"), { status: 409 });
    const report = cleanText(input.report || input.content || input.text);
    let status = normalizeTaskStatus(input.status, report ? "reported" : "in_progress");
    const acceptanceResults = safeArray(input.acceptanceResults);
    const artifacts = input.artifacts === undefined ? safeArray(target.artifacts) : safeArray(input.artifacts);
    const finalReport = report || target.report || "";
    let acceptanceFailure = "";
    if (status === "completed") {
      if (acceptanceResults.some(check => check?.passed === false)) acceptanceFailure = "Acceptance check failed";
      if (target.requireAcceptance) {
        if (!safeArray(target.acceptanceCriteria).every(criterion => acceptanceResults.some(check => check?.criterion === criterion && check.passed === true && cleanText(check.evidence)))) acceptanceFailure = "Acceptance evidence missing or failed";
        if (!finalReport && !artifacts.length) acceptanceFailure = "Deliverable report or artifact reference required";
        if (target.outputFormat === "json") {
          try { JSON.parse(finalReport); } catch { acceptanceFailure = "Deliverable is not valid JSON"; }
        }
      }
      if (acceptanceFailure) status = "blocked";
    }
    const patch = {
      status,
      report: finalReport,
      artifacts,
      ...(input.acceptanceResults !== undefined ? { acceptanceResults } : {}),
      acceptanceFailure,
    };
    const updated = await store.updateTask(target.id, patch);
    if (updated) {
      try {
        ctx.bus?.emit?.({
          type: "company_task_updated",
          companyId: updated.companyId,
          taskId: updated.id,
          channelId: updated.channelId || null,
          assigneeRole: updated.assigneeRole,
          assigneeAgentId: updated.assigneeAgentId || null,
          status: updated.status,
          task: updated,
        }, null);
      } catch {
        // The persisted task update is authoritative; event delivery is best-effort.
      }
    }
    if (updated?.source?.runId) await dispatchWorkflowRun(company.id, updated.source.runId);
    return updated;
  }

  function assignFromCanvas(input = {}) {
    const runId = cleanText(input.runId);
    if (!runId) return assignCanvasTasks(input);
    const key = runKey(input.companyId, runId);
    if (runAssignments.has(key)) return runAssignments.get(key);
    const promise = assignCanvasTasks(input).finally(() => runAssignments.delete(key));
    runAssignments.set(key, promise);
    return promise;
  }

  async function assignCanvasTasks(input = {}) {
    const company = await ensureCompany(input.companyId);
    const workflow = input.workflow && typeof input.workflow === "object" ? input.workflow : null;
    const sourceType = cleanText(input.sourceType) || (workflow ? "workflow_canvas" : "ai_movie_canvas");
    const workflowId = cleanText(input.workflowId || workflow?.id || input.canvas?.id || input.documentId) || id("workflow");
    const workflowTitle = cleanText(workflow?.title || input.canvas?.title || input.title);
    const linkedChannel = await resolveLinkedChannel(input.channelId);
    const channelInfo = linkedChannel.info;
    await ensureInternalChannelBinding(company, input.channelId, linkedChannel);
    const workflowSupervision = workflow?.supervision && typeof workflow.supervision === "object"
      ? workflow.supervision
      : {};
    const supervisorAgentIds = unique([
      ...channelSupervisorAgentIds(channelInfo),
      ...safeArray(workflowSupervision.supervisorAgentIds).map((agentId) => cleanText(agentId)),
      ...safeArray(input.supervisorAgentIds).map((agentId) => cleanText(agentId)),
    ]).filter(Boolean);

    const rawItems = safeArray(workflow?.nodes).length
      ? safeArray(workflow?.nodes)
      : safeArray(input.nodes).length
        ? safeArray(input.nodes)
        : safeArray(input.items);
    const items = rawItems
      .map((item, index) => ({ item, key: workflowItemKey(item, index) }))
      .filter(({ item }) => cleanText(item?.title || item?.prompt || item?.description || input.command));
    const workflowEdges = [
      ...safeArray(workflow?.edges),
      ...safeArray(input.edges),
    ];
    const runId = cleanText(input.runId);
    if (runId) {
      const existing = (await store.listTasks(company.id)).filter(task => task.source?.runId === runId);
      if (existing.length) return { companyId: company.id, tasks: existing };
      if (cancelledRuns.has(runKey(company.id, runId))) return { companyId: company.id, tasks: [], cancelled: true };
      const keys = new Set(items.map(({ key }) => key));
      if (keys.size !== items.length) throw Object.assign(new Error("Duplicate workflow node IDs"), { status: 400 });
      if (workflowEdges.some(edge => !keys.has(cleanText(edge.from)) || !keys.has(cleanText(edge.to)))) throw Object.assign(new Error("Workflow references an unknown dependency"), { status: 400 });
      const remaining = new Set(keys);
      while (remaining.size) {
        const ready = [...remaining].filter(key => !workflowEdges.some(edge => cleanText(edge.to) === key && remaining.has(cleanText(edge.from))));
        if (!ready.length) throw Object.assign(new Error("Workflow contains a dependency cycle"), { status: 400 });
        ready.forEach(key => remaining.delete(key));
      }
    }
    const treeId = id("tree");
    const taskIdsByNode = new Map(items.map(({ key }) => [key, id("task")]));

    const tasks = items.map(({ item, key }) => {
      const role = workflowNodeRole(item, channelInfo);
      const dependsOn = workflowEdges
        .filter((edge) => cleanText(edge?.to) === key)
        .map((edge) => taskIdsByNode.get(cleanText(edge?.from)))
        .filter(Boolean);
      const agentId = cleanText(item.assigneeAgentId || item.agentId);
      const base = taskForRole(company, role, {
        companyId: company.id,
        channelId: linkedChannel.channelId || input.channelId,
        command: cleanText(item.prompt || item.description || item.command || input.command || item.title),
        title: item.title,
        dueAt: input.dueAt,
        acceptanceCriteria: safeArray(item.acceptanceCriteria).length ? item.acceptanceCriteria : input.acceptanceCriteria,
        requireAcceptance: item.requireAcceptance === true || input.requireAcceptance === true,
        outputFormat: item.outputFormat || input.outputFormat,
        writePaths: item.writePaths,
        source: {
          type: sourceType,
          workflowId,
          workflowTitle,
          ...(runId ? { runId, dispatchChannelId: linkedChannel.channelId || input.channelId } : {}),
          nodeId: key,
          nodeType: cleanText(item.kind || item.itemType || "task"),
          supervision: {
            mode: cleanText(workflowSupervision.mode) || "director_group",
            supervisorAgentIds,
          },
        },
      }, {
        ...(runId ? { status: "queued" } : {}),
        id: taskIdsByNode.get(key),
        treeId,
        parentTaskId: dependsOn[0] || "",
        dependsOn,
        taskKind: sourceType === "workflow_canvas" ? "workflow_node" : "canvas_node",
        depth: dependsOn.length ? 1 : 0,
        workflowNode: {
          id: key,
          title: cleanText(item.title),
          agentId,
          dependencies: workflowEdges
            .filter((edge) => cleanText(edge?.to) === key)
            .map((edge) => cleanText(edge?.from))
            .filter(Boolean),
        },
        productionNode: {
          itemId: cleanText(item.itemId || key),
          itemType: cleanText(item.itemType || item.kind),
          dependencies: safeArray(item.dependencies),
          assetRefs: safeArray(item.assetRefs),
        },
      });
      if (!agentId) return base;
      return {
        ...base,
        assigneeAgentId: agentId,
        assigneeAgentName: agentNameFromChannel(channelInfo, agentId) || base.assigneeAgentName || "",
        mentions: unique([`@${agentId}`, ...safeArray(base.mentions)]),
      };
    });
    // Declared write ownership is a coordination guard, not filesystem isolation.
    const validateOwnership = (existing) => {
      const seen = existing.filter(task => task.companyId === company.id && !["completed", "failed", "cancelled"].includes(task.status));
      const overlaps = (a, b) => a === b || a === "/" || b === "/" || (a === "." && !b.startsWith("/")) || (b === "." && !a.startsWith("/")) || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      for (const task of tasks) {
        for (const other of seen) {
          if (safeArray(task.writePaths).some(a => safeArray(other.writePaths).some(b => overlaps(a, b)))) {
            throw Object.assign(new Error(`Declared write ownership conflict with task ${other.id}`), { status: 409 });
          }
        }
        seen.push(task);
      }
    };
    const created = await store.addTasks(tasks, validateOwnership);
    if (runId) {
      if (cancelledRuns.has(runKey(company.id, runId))) await cancelWorkflowRun({ companyId: company.id, runId });
      else await dispatchWorkflowRun(company.id, runId);
      return { companyId: company.id, tasks: (await store.listTasks(company.id)).filter(task => task.source?.runId === runId) };
    }
    emitAssignedTasks(created);
    await postAssignedTasksToChannel(created, {
      ...input,
      dispatchChannelId: linkedChannel.channelId || input.channelId,
      supervisorAgentIds,
    }, channelInfo);
    return { companyId: company.id, tasks: created };
  }

  async function getStatus(companyId) {
    const company = await ensureCompany(companyId);
    const channels = await store.listChannels(company.id);
    const tasks = await store.listTasks(company.id);
    return { company, channels, tasks, summary: statusSummary(company, channels, tasks) };
  }

  async function clearTasks(input = {}) {
    const company = await ensureCompany(input.companyId);
    const channelIds = unique([
      cleanText(input.channelId),
      ...safeArray(input.channelIds).map((item) => cleanText(item)),
    ]).filter(Boolean);
    return store.clearTasks({ companyId: company.id, channelIds });
  }

  return {
    store,
    createDefaultCompany,
    bindChannel,
    ingestChannelMessage,
    postChannelReply,
    updateChannelStatus,
    reportTask,
    assignCommand,
    assignFromCanvas,
    cancelWorkflowRun,
    clearTasks,
    getStatus,
    updateTask: (taskId, patch) => store.updateTask(taskId, patch),
    listCompanies: () => store.listCompanies(),
  };
}

export function getCompanyService(ctx) {
  if (ctx._company?.service) return ctx._company.service;
  const service = createCompanyService(ctx);
  ctx._company = { ...(ctx._company || {}), service, store: service.store };
  return service;
}
