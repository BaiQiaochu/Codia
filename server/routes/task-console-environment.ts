import fs from 'node:fs';
import path from 'node:path';
import { filterToolObjectsByAvailability } from '../../core/tool-availability.ts';
import type { TaskTemplate, CheckState } from '../../shared/task-console/templates.ts';

/** Inspect the existing runtime only. Never connects, refreshes credentials, or invokes a tool. */
export function diagnoseTemplateEnvironment(engine: any, template: TaskTemplate, inputs: Record<string, string>, options: any = {}) {
  const agent = engine.agent;
  const requested = Array.isArray(options.connectorTools) ? options.connectorTools : [];
  const invalidSelection = requested.some((name: unknown) => typeof name !== 'string' || name.length > 200) || requested.length > 50;
  let tools: any[] = [];
  let available = new Set<string>();
  let registryKnown = false;
  let mcp: any = null;
  try {
    registryKnown = Array.isArray(agent?.tools);
    tools = [...(agent?.tools || []), ...(engine.pluginManager?.getAllTools?.() || [])];
    available = new Set(filterToolObjectsByAvailability(tools, agent?.config || {}, { agentId: agent?.id }).map((tool: any) => tool.name));
    mcp = engine.pluginManager?.getPlugin?.('mcp')?.ctx?._mcpRuntime?.getState(agent?.config || {});
  } catch { registryKnown = false; }
  const requirements = [...template.requiredTools, ...requested.filter((name: unknown) => typeof name === 'string')];
  const checks = requirements.map(name => {
    const tool = tools.find(candidate => candidate.name === name);
    const connectorId = tool?.metadata?.connectorId || tool?.metadata?.serverId;
    const connector = connectorId && mcp?.connectors?.find((item: any) => item.id === connectorId);
    let state: CheckState = !registryKnown ? 'unknown' : !tool || !available.has(name) ? 'fail' : 'pass';
    if (tool?._pluginId === 'mcp' || tool?.metadata?.kind === 'mcp') {
      state = !mcp || !connector ? 'unknown' : mcp.enabled !== true || connector.status !== 'running' || !available.has(name) ? 'fail' : 'pass';
    }
    return { name, state, connectorId: connectorId || null, connection: connector?.status || null };
  });
  const connectorState: CheckState = invalidSelection || checks.some(check => check.state === 'fail') ? 'fail' : checks.some(check => check.state === 'unknown') ? 'unknown' : 'pass';
  const directory = checkDirectory(engine, inputs['项目目录'] || options.workspace);
  return {
    tools: { state: connectorState, observedAt: Date.now(), healthSource: 'existing-runtime-state', checks, availableConnectorTools: tools.filter(tool => tool._pluginId === 'mcp' && available.has(tool.name)).map(tool => tool.name),
      note: '仅检查已注册工具、当前 Agent 授权与现有 MCP 客户端连接状态；未发起网络探测或工具调用，不代表外部服务操作已实测。' },
    directory,
  };
}

function checkDirectory(engine: any, input: unknown) {
  const result = (state: CheckState, reason: string, directory: string | null = null) => ({ state, reason, path: directory });
  if (typeof input !== 'string' || !input.trim()) return result('unknown', '请选择已授权的现有工作目录。');
  if (!path.isAbsolute(input.trim()) || input.includes('\0')) return result('fail', '目录必须是绝对路径。');
  let scope: any;
  try { scope = engine.getSessionFolderScope?.(); } catch { return result('unknown', '无法读取当前会话目录授权。'); }
  if (!scope || !Array.isArray(scope.sandboxFolders)) return result('unknown', '当前会话目录授权尚不可用。');
  // realpath both roots and target: a symlink must not enlarge an existing grant.
  try {
    const directory = fs.realpathSync(input.trim());
    const authorized = scope.sandboxFolders.some((root: unknown) => {
      if (typeof root !== 'string' || !root) return false;
      try { const canonical = fs.realpathSync(root); const relative = path.relative(canonical, directory); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); } catch { return false; }
    });
    if (!authorized) return result('fail', '目录不在当前会话的沙箱授权范围内。');
    if (!fs.statSync(directory).isDirectory()) return result('fail', '目标不是现有目录。');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return result('pass', '目录存在、位于当前会话授权范围，且当前进程具备读取/写入/遍历权限；执行时仍由沙箱重新校验。', directory);
  } catch { return result('fail', '目录不存在或当前进程无法访问。'); }
}
