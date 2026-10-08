export interface WorkflowTemplateDraftNode {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
}

export interface WorkflowTemplateDraftEdge {
  from: string;
  to: string;
}

export interface WorkflowTemplateDraft {
  title: string;
  nodes: WorkflowTemplateDraftNode[];
  edges: WorkflowTemplateDraftEdge[];
}

export type WorkflowTemplateDraftValidation =
  | { ok: true; draft: WorkflowTemplateDraft }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${field}不能为空`, value: '' };
  }
  const text = value.trim();
  if (text.length > maxLength) {
    return { error: `${field}不能超过 ${maxLength} 个字符`, value: '' };
  }
  return { error: '', value: text };
}

function containsCycle(nodes: WorkflowTemplateDraftNode[], edges: WorkflowTemplateDraftEdge[]) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) || []) {
      const next = (indegree.get(target) || 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  return visited !== nodes.length;
}

export function extractWorkflowTemplateJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const source = value.trim();
  if (!source) return null;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function validateWorkflowTemplateDraft(
  value: unknown,
  options: { allowedAgentIds?: readonly string[] } = {},
): WorkflowTemplateDraftValidation {
  const record = asRecord(extractWorkflowTemplateJson(value));
  if (!record) return { ok: false, error: '模型没有返回有效的工作流 JSON' };
  if (!Array.isArray(record.nodes) || record.nodes.length < 2 || record.nodes.length > 8) {
    return { ok: false, error: '工作流模板必须包含 2 到 8 个节点' };
  }
  if (!Array.isArray(record.edges) || record.edges.length > 24) {
    return { ok: false, error: '工作流模板连线格式无效或超过 24 条' };
  }

  const restrictAgentIds = Array.isArray(options.allowedAgentIds);
  const allowedAgentIds = new Set((options.allowedAgentIds || []).map(String).filter(Boolean));
  const nodes: WorkflowTemplateDraftNode[] = [];
  const nodeIds = new Set<string>();
  for (let index = 0; index < record.nodes.length; index += 1) {
    const raw = asRecord(record.nodes[index]);
    if (!raw) return { ok: false, error: `第 ${index + 1} 个节点格式无效` };
    const idResult = requiredText(raw.id, `第 ${index + 1} 个节点 ID`, 80);
    if (idResult.error) return { ok: false, error: idResult.error };
    if (!/^[a-zA-Z0-9_-]+$/.test(idResult.value)) {
      return { ok: false, error: `节点 ID “${idResult.value}”只能包含字母、数字、下划线和短横线` };
    }
    if (nodeIds.has(idResult.value)) return { ok: false, error: `节点 ID “${idResult.value}”重复` };
    const titleResult = requiredText(raw.title, `节点 “${idResult.value}”名称`, 120);
    if (titleResult.error) return { ok: false, error: titleResult.error };
    const promptResult = requiredText(raw.prompt, `节点 “${idResult.value}”执行目标`, 2000);
    if (promptResult.error) return { ok: false, error: promptResult.error };
    if (typeof raw.agentId !== 'string') {
      return { ok: false, error: `节点 “${idResult.value}”的 Agent ID 格式无效` };
    }
    const agentId = raw.agentId.trim();
    if (agentId && restrictAgentIds && !allowedAgentIds.has(agentId)) {
      return { ok: false, error: `节点 “${idResult.value}”引用了不存在的 Agent` };
    }
    nodeIds.add(idResult.value);
    nodes.push({
      id: idResult.value,
      title: titleResult.value,
      prompt: promptResult.value,
      agentId,
    });
  }

  const edges: WorkflowTemplateDraftEdge[] = [];
  const edgeKeys = new Set<string>();
  for (let index = 0; index < record.edges.length; index += 1) {
    const raw = asRecord(record.edges[index]);
    const from = typeof raw?.from === 'string' ? raw.from.trim() : '';
    const to = typeof raw?.to === 'string' ? raw.to.trim() : '';
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) {
      return { ok: false, error: `第 ${index + 1} 条连线引用了不存在的节点` };
    }
    if (from === to) return { ok: false, error: `节点 “${from}”不能连接到自身` };
    const key = `${from}->${to}`;
    if (edgeKeys.has(key)) return { ok: false, error: `连线 “${key}”重复` };
    edgeKeys.add(key);
    edges.push({ from, to });
  }
  if (containsCycle(nodes, edges)) return { ok: false, error: '模板包含循环连线，请生成无环工作流' };

  const titleResult = requiredText(record.title, '工作流模板名称', 120);
  if (titleResult.error) return { ok: false, error: titleResult.error };

  return {
    ok: true,
    draft: {
      title: titleResult.value,
      nodes,
      edges,
    },
  };
}
