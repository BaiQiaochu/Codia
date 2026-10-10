import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { AgentPhoneActivity, ChannelMemberRole } from '../../types';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import {
  createChannelAgent,
  loadChannels,
  removeChannelMember,
  updateChannelMemberRole,
} from '../../stores/channel-actions';
import {
  buildAgentMap,
  MemberAvatar,
  resolveChannelMember,
} from './channel-member-utils';
import {
  countChannelRoles,
  getChannelRoleLabel,
} from './channel-role-utils';
import { ChannelAutomationSection } from './ChannelAutomationSection';
import styles from './Channels.module.css';

const YUAN_OPTIONS = ['codia', 'butter', 'ming', 'kong'] as const;

const YUAN_NAME_FALLBACKS: Record<(typeof YUAN_OPTIONS)[number], string> = {
  codia: '均衡',
  butter: '情感',
  ming: '理性',
  kong: '原始',
};

interface CompanyStatusChannel {
  id: string;
  internalChannelId?: string;
}

interface CompanyTask {
  id: string;
  treeId?: string;
  parentTaskId?: string;
  taskKind?: string;
  depth?: number;
  channelId?: string;
  title?: string;
  description?: string;
  assigneeRole?: string;
  assigneeTitle?: string;
  assigneeAgentId?: string;
  status?: string;
  acceptanceCriteria?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface CompanyTaskNode extends CompanyTask {
  children: CompanyTaskNode[];
}

interface CompanyStatus {
  channels: CompanyStatusChannel[];
  tasks: CompanyTask[];
}

interface CompanyTaskTree {
  id: string;
  roots: CompanyTaskNode[];
  taskCount: number;
  assigneeCount: number;
}

function localText(key: string, fallback: string) {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

function yuanTypeDisplayName(key: (typeof YUAN_OPTIONS)[number]) {
  const value = window.t?.(`yuan.types.${key}.name`);
  return value && value !== `yuan.types.${key}.name` ? String(value) : YUAN_NAME_FALLBACKS[key];
}

function taskTitle(task: CompanyTask) {
  return task.title || task.description || task.id;
}

function taskStatusLabel(status?: string) {
  const key = String(status || 'assigned');
  const labels: Record<string, string> = {
    assigned: '已分派',
    in_progress: '执行中',
    reported: '已回报',
    completed: '已完成',
    blocked: '受阻',
    failed: '失败',
  };
  return labels[key] || key;
}

function taskStatusClass(status?: string) {
  const key = String(status || 'assigned');
  const map: Record<string, string> = {
    assigned: styles.channelTaskStatusAssigned,
    in_progress: styles.channelTaskStatusActive,
    reported: styles.channelTaskStatusReported,
    completed: styles.channelTaskStatusCompleted,
    blocked: styles.channelTaskStatusBlocked,
    failed: styles.channelTaskStatusBlocked,
  };
  return map[key] || styles.channelTaskStatusAssigned;
}

function channelScopeIds(currentChannel: string | null, channels: CompanyStatusChannel[]) {
  if (!currentChannel) return new Set<string>();
  const ids = new Set([currentChannel]);
  for (const channel of channels) {
    if (channel.id === currentChannel || channel.internalChannelId === currentChannel) {
      ids.add(channel.id);
      if (channel.internalChannelId) ids.add(channel.internalChannelId);
    }
  }
  return ids;
}

function taskSortValue(task: CompanyTask) {
  return `${String(task.depth ?? 0).padStart(4, '0')}:${task.createdAt || ''}:${task.id}`;
}

function sortTaskNodes(nodes: CompanyTaskNode[]): CompanyTaskNode[] {
  return [...nodes]
    .sort((a, b) => taskSortValue(a).localeCompare(taskSortValue(b)))
    .map((node) => ({ ...node, children: sortTaskNodes(node.children) }));
}

function buildTaskTrees(tasks: CompanyTask[]): CompanyTaskTree[] {
  const grouped = new Map<string, CompanyTask[]>();
  for (const task of tasks) {
    const key = task.treeId || task.parentTaskId || task.id;
    const group = grouped.get(key) || [];
    group.push(task);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([id, group]) => {
    const nodes = new Map<string, CompanyTaskNode>();
    for (const task of group) nodes.set(task.id, { ...task, children: [] });

    const roots: CompanyTaskNode[] = [];
    for (const node of nodes.values()) {
      const parentId = node.parentTaskId || '';
      const parent = parentId ? nodes.get(parentId) : null;
      if (parent && parent.id !== node.id) parent.children.push(node);
      else roots.push(node);
    }

    if (roots.length === 0) {
      const fallback = [...nodes.values()].sort((a, b) => taskSortValue(a).localeCompare(taskSortValue(b)))[0];
      if (fallback) roots.push(fallback);
    }

    const assignees = new Set(group.map((task) => task.assigneeAgentId).filter(Boolean));
    return {
      id,
      roots: sortTaskNodes(roots),
      taskCount: group.length,
      assigneeCount: assignees.size,
    };
  });
}

function summarizeTasks(tasks: CompanyTask[]) {
  const assignees = new Set(tasks.map((task) => task.assigneeAgentId).filter(Boolean));
  return {
    total: tasks.length,
    active: tasks.filter((task) => ['assigned', 'in_progress', 'reported'].includes(String(task.status || 'assigned'))).length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    blocked: tasks.filter((task) => task.status === 'blocked' || task.status === 'failed').length,
    assigneeCount: assignees.size,
  };
}

function channelRoleForTask(
  task: CompanyTask,
  memberRoles: Record<string, ChannelMemberRole>,
): ChannelMemberRole {
  const assignedRole = task.assigneeAgentId ? memberRoles[task.assigneeAgentId] : undefined;
  if (assignedRole) return assignedRole;
  if (task.assigneeRole === 'project_manager') return 'project_manager';
  if (task.assigneeRole === 'admin') return 'admin';
  if (task.assigneeRole === 'worker') return 'worker';
  if (task.assigneeRole === 'ops_qc') return 'admin';
  return 'worker';
}

function summarizeRoleTasks(
  tasks: CompanyTask[],
  memberRoles: Record<string, ChannelMemberRole>,
) {
  const empty = () => ({ total: 0, active: 0, completed: 0, blocked: 0 });
  const stats: Record<ChannelMemberRole, ReturnType<typeof empty>> = {
    project_manager: empty(),
    admin: empty(),
    worker: empty(),
  };

  for (const task of tasks) {
    const role = channelRoleForTask(task, memberRoles);
    const bucket = stats[role];
    bucket.total += 1;
    const status = String(task.status || 'assigned');
    if (status === 'completed') bucket.completed += 1;
    else if (status === 'blocked' || status === 'failed') bucket.blocked += 1;
    else bucket.active += 1;
  }

  return stats;
}

function isBlockedTask(task: CompanyTask) {
  const status = String(task.status || 'assigned');
  return status === 'blocked' || status === 'failed';
}

function isReviewTask(task: CompanyTask) {
  return String(task.status || '') === 'reported';
}

function assignmentChannelLabel(task: CompanyTask) {
  return task.channelId || '未绑定频道';
}

function suggestAgentName(
  role: ChannelMemberRole,
  existingNames: string[],
) {
  const base = getChannelRoleLabel(role);
  const used = new Set(existingNames.filter(Boolean));
  for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base}${index}`;
    if (!used.has(candidate)) return candidate;
    index += 1;
  }
}

export function ChannelWorkspacePanel() {
  const currentChannel = useStore((s) => s.currentChannel);
  const channelMembers = useStore((s) => s.channelMembers);
  const channelMemberRoles = useStore((s) => s.channelMemberRoles);
  const channelInfoName = useStore((s) => s.channelInfoName);
  const channelInfoDescription = useStore((s) => s.channelInfoDescription);
  const agents = useStore((s) => s.agents);
  const userName = useStore((s) => s.userName);
  const userAvatarUrl = useStore((s) => s.userAvatarUrl);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const allActivities = useStore((s) => s.channelAgentActivities);
  const channelMessagesCount = useStore((s) => s.channelMessages.length);
  const addToast = useStore((s) => s.addToast);
  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);

  const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('');
  const [agentYuan, setAgentYuan] = useState<(typeof YUAN_OPTIONS)[number]>('codia');
  const [agentRole, setAgentRole] = useState<ChannelMemberRole>('worker');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentNameEdited, setAgentNameEdited] = useState(false);
  const [companyStatus, setCompanyStatus] = useState<CompanyStatus | null>(null);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [companyError, setCompanyError] = useState('');
  const [clusterCommand, setClusterCommand] = useState('');
  const [dispatchingCluster, setDispatchingCluster] = useState(false);
  const [clearingTaskTrees, setClearingTaskTrees] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState('');
  const infoSectionRef = useRef<HTMLDivElement>(null);
  const membersSectionRef = useRef<HTMLDivElement>(null);
  const taskListRef = useRef<HTMLDivElement>(null);

  const roleCounts = useMemo(() => countChannelRoles(channelMemberRoles), [channelMemberRoles]);

  const teamMembers = useMemo(
    () => channelMembers.map((memberId) => ({
      id: memberId,
      info: resolveChannelMember(memberId, userName, userAvatarUrl, agents, currentAgentId, agentMap),
      role: channelMemberRoles[memberId] || 'worker',
    })),
    [agentMap, agents, channelMemberRoles, channelMembers, currentAgentId, userAvatarUrl, userName],
  );
  const canRemoveMembers = channelMembers.length > 0;

  const loadCompanyStatus = useCallback(async () => {
    if (!currentChannel) return;
    setCompanyLoading(true);
    setCompanyError('');
    try {
      const res = await codiaFetch('/api/plugins/company/companies/default/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompanyStatus({
        channels: Array.isArray(data.channels) ? data.channels : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      });
    } catch (err) {
      setCompanyStatus(null);
      setCompanyError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompanyLoading(false);
    }
  }, [currentChannel]);

  useEffect(() => {
    void loadCompanyStatus();
  }, [loadCompanyStatus, channelMessagesCount]);

  const scopedChannelIds = useMemo(
    () => [...channelScopeIds(currentChannel, companyStatus?.channels || [])],
    [companyStatus, currentChannel],
  );

  const scopedCompanyTasks = useMemo(() => {
    const ids = new Set(scopedChannelIds);
    return (companyStatus?.tasks || []).filter((task) => {
      const taskChannelId = task.channelId || '';
      return !taskChannelId || ids.has(taskChannelId);
    });
  }, [companyStatus, scopedChannelIds]);

  const scopedTaskTrees = useMemo(() => buildTaskTrees(scopedCompanyTasks), [scopedCompanyTasks]);
  const allTaskTrees = useMemo(() => buildTaskTrees(companyStatus?.tasks || []), [companyStatus?.tasks]);
  const taskSummary = useMemo(() => summarizeTasks(scopedCompanyTasks), [scopedCompanyTasks]);
  const roleTaskStats = useMemo(
    () => summarizeRoleTasks(scopedCompanyTasks, channelMemberRoles),
    [channelMemberRoles, scopedCompanyTasks],
  );
  const directorSupervisors = useMemo(
    () => teamMembers.filter((member) => member.role === 'project_manager' || member.role === 'admin'),
    [teamMembers],
  );
  const directorSummary = useMemo(() => {
    const allTasks = companyStatus?.tasks || [];
    const scopedIds = new Set(scopedChannelIds);
    const assignedTasks = allTasks.filter((task) => task.assigneeAgentId);
    const crossChannelTasks = allTasks.filter((task) => {
      const channelId = task.channelId || '';
      return channelId && !scopedIds.has(channelId);
    });
    const blockedTasks = allTasks.filter(isBlockedTask);
    const reviewTasks = allTasks.filter(isReviewTask);
    const activeTasks = allTasks.filter((task) => ['assigned', 'in_progress', 'reported'].includes(String(task.status || 'assigned')));
    const activeAgents = new Set(activeTasks.map((task) => task.assigneeAgentId).filter(Boolean));
    return {
      allTasks,
      assignedTasks,
      crossChannelTasks,
      blockedTasks,
      reviewTasks,
      activeAgentCount: activeAgents.size,
    };
  }, [companyStatus?.tasks, scopedChannelIds]);
  const roleLanes = useMemo(() => ([
    {
      role: 'project_manager' as ChannelMemberRole,
      label: getChannelRoleLabel('project_manager'),
      members: teamMembers.filter((member) => member.role === 'project_manager'),
      stats: roleTaskStats.project_manager,
    },
    {
      role: 'admin' as ChannelMemberRole,
      label: getChannelRoleLabel('admin'),
      members: teamMembers.filter((member) => member.role === 'admin'),
      stats: roleTaskStats.admin,
    },
    {
      role: 'worker' as ChannelMemberRole,
      label: getChannelRoleLabel('worker'),
      members: teamMembers.filter((member) => member.role === 'worker'),
      stats: roleTaskStats.worker,
    },
  ]), [roleTaskStats, teamMembers]);
  const workflowSteps = useMemo(() => ([
    { key: 'goal', label: '目标', value: taskSummary.total > 0 ? '已接收' : '等待输入', active: taskSummary.total > 0 },
    { key: 'split', label: '拆解', value: scopedTaskTrees.length > 0 ? `${scopedTaskTrees.length} 棵树` : '未生成', active: scopedTaskTrees.length > 0 },
    { key: 'dispatch', label: '派发', value: taskSummary.assigneeCount > 0 ? `${taskSummary.assigneeCount} Agent` : '未派发', active: taskSummary.assigneeCount > 0 },
    { key: 'report', label: '回报', value: taskSummary.completed > 0 ? `${taskSummary.completed} 完成` : `${taskSummary.active} 执行中`, active: taskSummary.active > 0 || taskSummary.completed > 0 },
  ]), [scopedTaskTrees.length, taskSummary.active, taskSummary.assigneeCount, taskSummary.completed, taskSummary.total]);

  const latestActivityByAgent = useMemo(() => {
    const byAgent = allActivities?.[currentChannel || ''] || {};
    const latest: Record<string, AgentPhoneActivity | undefined> = {};
    for (const [agentId, history] of Object.entries(byAgent)) {
      latest[agentId] = Array.isArray(history) ? history[0] : undefined;
    }
    return latest;
  }, [allActivities, currentChannel]);

  const scrollTaskNodeIntoView = useCallback((taskId: string) => {
    const root = taskListRef.current;
    const escapedTaskId = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(taskId)
      : taskId.replace(/["\\]/g, '\\$&');
    const target = root?.querySelector<HTMLElement>(`[data-company-task-id="${escapedTaskId}"]`);
    if (!target) return;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus({ preventScroll: true });
    });
  }, []);

  const focusTaskAndWorkflowNode = useCallback((taskId: string) => {
    setFocusedTaskId(taskId);
    window.dispatchEvent(new CustomEvent('codia-channel-task-focus-workflow', {
      detail: { taskId, channelId: currentChannel },
    }));
  }, [currentChannel]);

  useEffect(() => {
    const handleWorkflowFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; channelId?: string }>).detail || {};
      if (!detail.taskId) return;
      if (detail.channelId && detail.channelId !== currentChannel) return;
      setFocusedTaskId(detail.taskId);
      scrollTaskNodeIntoView(detail.taskId);
    };
    window.addEventListener('codia-channel-workflow-focus-task', handleWorkflowFocus);
    return () => window.removeEventListener('codia-channel-workflow-focus-task', handleWorkflowFocus);
  }, [currentChannel, scrollTaskNodeIntoView]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail;
      if (!detail?.channelId || detail.channelId === currentChannel) {
        setFormOpen(true);
      }
    };
    window.addEventListener('codia-channel-open-agent-create', handleOpen);
    return () => window.removeEventListener('codia-channel-open-agent-create', handleOpen);
  }, [currentChannel]);

  useEffect(() => {
    const focusSection = (target: HTMLElement | null) => {
      if (!target) return;
      window.requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    };
    const handleInfoFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail || {};
      if (detail.channelId && detail.channelId !== currentChannel) return;
      focusSection(infoSectionRef.current);
    };
    const handleMembersFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail || {};
      if (detail.channelId && detail.channelId !== currentChannel) return;
      focusSection(membersSectionRef.current);
    };
    window.addEventListener('codia-channel-focus-info', handleInfoFocus);
    window.addEventListener('codia-channel-focus-members', handleMembersFocus);
    return () => {
      window.removeEventListener('codia-channel-focus-info', handleInfoFocus);
      window.removeEventListener('codia-channel-focus-members', handleMembersFocus);
    };
  }, [currentChannel]);

  useEffect(() => {
    setAgentName('');
    setAgentYuan('codia');
    setAgentRole('worker');
    setCreatingAgent(false);
    setAgentNameEdited(false);
    setSavingRoleFor(null);
    setFormOpen(false);
    setClusterCommand('');
    setDispatchingCluster(false);
    setClearingTaskTrees(false);
    setFocusedTaskId('');
  }, [currentChannel]);

  useEffect(() => {
    if (!formOpen || agentNameEdited) return;
    const existingNames = teamMembers.map(({ info }) => info.displayName);
    setAgentName(suggestAgentName(agentRole, existingNames));
  }, [agentNameEdited, agentRole, formOpen, teamMembers]);

  const handleRoleChange = useCallback(async (memberId: string, role: ChannelMemberRole) => {
    if (!currentChannel) return;
    setSavingRoleFor(memberId);
    try {
      await updateChannelMemberRole(currentChannel, memberId, role);
      addToast(window.t?.('channel.roleUpdated') || '角色已更新', 'success', 2200);
    } catch (err) {
      addToast(
        `${window.t?.('channel.roleUpdateFailed') || '角色更新失败'}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setSavingRoleFor(null);
    }
  }, [addToast, currentChannel]);

  const handleRemoveMember = useCallback(async (memberId: string, displayName: string) => {
    if (!currentChannel || removingMemberId || !canRemoveMembers) return;
    const confirmed = window.confirm(
      window.t?.('channel.removeMemberConfirm', { name: displayName })
        || `Remove ${displayName} from this channel?`,
    );
    if (!confirmed) return;
    setRemovingMemberId(memberId);
    try {
      await removeChannelMember(currentChannel, memberId);
      await loadChannels();
      addToast(window.t?.('channel.memberRemoved', { name: displayName }) || `${displayName} 已移出频道`, 'success', 2200);
    } catch (err) {
      addToast(
        `${window.t?.('channel.removeMemberFailed') || '移除成员失败'}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setRemovingMemberId(null);
    }
  }, [addToast, canRemoveMembers, currentChannel, removingMemberId]);

  const handleCreateAgent = useCallback(async () => {
    if (!currentChannel || creatingAgent) return;
    if (!agentName.trim()) {
      addToast(window.t?.('channel.createAgentNameRequired') || '请输入助手名称', 'error', 2200);
      return;
    }
    setCreatingAgent(true);
    try {
      const created = await createChannelAgent(currentChannel, {
        name: agentName.trim(),
        yuan: agentYuan,
        role: agentRole,
      });
      addToast(window.t?.('channel.agentCreated', { name: created.name }) || `${created.name} 已创建`, 'success', 2600);
      setAgentName('');
      setAgentYuan('codia');
      setAgentRole('worker');
      setAgentNameEdited(false);
      setFormOpen(false);
    } catch (err) {
      addToast(
        `${window.t?.('channel.agentCreateFailed') || '创建助手失败'}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setCreatingAgent(false);
    }
  }, [addToast, agentName, agentRole, agentYuan, creatingAgent, currentChannel]);

  const handleClusterAssign = useCallback(async () => {
    const command = clusterCommand.trim();
    if (!currentChannel || !command || dispatchingCluster) return;
    setDispatchingCluster(true);
    try {
      const res = await codiaFetch('/api/plugins/company/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: currentChannel,
          command,
          source: { type: 'channel_workspace_cluster' },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      addToast(`已派发 ${tasks.length} 个任务`, 'success', 2600);
      setClusterCommand('');
      await loadCompanyStatus();
    } catch (err) {
      addToast(`集群派发失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setDispatchingCluster(false);
    }
  }, [addToast, clusterCommand, currentChannel, dispatchingCluster, loadCompanyStatus]);

  const handleClearTaskTrees = useCallback(async () => {
    if (!currentChannel || clearingTaskTrees) return;
    setClearingTaskTrees(true);
    try {
      const res = await codiaFetch('/api/plugins/company/tasks/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: 'company_default',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      addToast(`已清空 ${Number(data.removedCount || 0)} 个任务`, 'success', 2200);
      setCompanyStatus((prev) => prev ? { ...prev, tasks: [] } : prev);
      await loadCompanyStatus();
    } catch (err) {
      addToast(`清空任务树失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setClearingTaskTrees(false);
    }
  }, [addToast, clearingTaskTrees, currentChannel, loadCompanyStatus]);

  return (
    <div className={`universal-card jian-card ${styles.channelWorkspaceCard}`}>
      <div ref={infoSectionRef} className={`channel-info-section ${styles.channelWorkspaceHero}`}>
        <div className={styles.channelWorkspaceHeroMain}>
          <div className="channel-info-label">{localText('channel.workspaceTitle', '工作群')}</div>
          <div className={`channel-info-name ${styles.channelInfoNameWrap}`}>{channelInfoName}</div>
          {channelInfoDescription && (
            <div className={styles.channelWorkspaceDescription}>{channelInfoDescription}</div>
          )}
        </div>
        <div className={styles.channelRoleSummary} aria-label="频道角色分布">
          {roleCounts.project_manager > 0 && (
            <span className={`${styles.channelRoleBadge} ${styles.roleProjectManager}`}>
              {getChannelRoleLabel('project_manager')} {roleCounts.project_manager}
            </span>
          )}
          {roleCounts.admin > 0 && (
            <span className={`${styles.channelRoleBadge} ${styles.roleAdmin}`}>
              {getChannelRoleLabel('admin')} {roleCounts.admin}
            </span>
          )}
          {roleCounts.worker > 0 && (
            <span className={`${styles.channelRoleBadge} ${styles.roleWorker}`}>
              {getChannelRoleLabel('worker')} {roleCounts.worker}
            </span>
          )}
        </div>
        <div className={styles.channelWorkspaceHint}>
          {localText('channel.workspaceHint', '项目经理负责拆解和协调，管理员负责维护流程和汇总，工人负责执行与回报。')}
        </div>
      </div>

      <ChannelAutomationSection />

      <div className={`channel-info-section ${styles.channelClusterWorkbench}`}>
        <div className={styles.channelSectionHeaderRow}>
          <div>
            <div className="channel-info-label">AI Agent 集群调用</div>
            <div className={styles.channelClusterSubtitle}>按任务树拆解目标，自动派发到频道成员并追踪 Agent 回报。</div>
          </div>
          <span className={styles.channelClusterBadge}>
            {scopedTaskTrees.length} 棵任务树
          </span>
        </div>
        <div className={styles.channelWorkflowSteps} aria-label="任务树执行阶段">
          {workflowSteps.map((step) => (
            <div
              key={step.key}
              className={`${styles.channelWorkflowStep}${step.active ? ` ${styles.channelWorkflowStepActive}` : ''}`}
            >
              <span>{step.label}</span>
              <strong>{step.value}</strong>
            </div>
          ))}
        </div>
        <div className={styles.channelClusterMetrics}>
          <span>任务 {taskSummary.total}</span>
          <span>执行中 {taskSummary.active}</span>
          <span>完成 {taskSummary.completed}</span>
          <span>Agent {taskSummary.assigneeCount}</span>
          {taskSummary.blocked > 0 && <span className={styles.channelClusterMetricWarn}>受阻 {taskSummary.blocked}</span>}
        </div>
        <textarea
          className={styles.channelClusterInput}
          value={clusterCommand}
          placeholder="输入项目目标，自动拆成任务树并派发给频道成员"
          rows={3}
          onChange={(e) => setClusterCommand(e.target.value)}
        />
        <div className={styles.channelClusterActions}>
          <button
            type="button"
            className={styles.channelClusterSubmit}
            disabled={!clusterCommand.trim() || dispatchingCluster || companyLoading}
            onClick={handleClusterAssign}
          >
            {dispatchingCluster ? '派发中' : '拆解并派发'}
          </button>
          <span className={styles.channelClusterHint}>
            由一人公司插件生成任务树并 @ 对应 Agent，频道调度会继续触发成员处理。
          </span>
        </div>
        <div className={styles.channelAgentLanes} aria-label="Agent 集群分工">
          {roleLanes.map((lane) => (
            <div key={lane.role} className={styles.channelAgentLane} data-role-lane={lane.role}>
              <div className={styles.channelAgentLaneHeader}>
                <span>{lane.label}</span>
                <strong>{lane.members.length}</strong>
              </div>
              <div className={styles.channelAgentLaneStats}>
                <span>任务 {lane.stats.total}</span>
                <span>执行 {lane.stats.active}</span>
                <span>完成 {lane.stats.completed}</span>
                {lane.stats.blocked > 0 && <span className={styles.channelAgentLaneBlocked}>受阻 {lane.stats.blocked}</span>}
              </div>
              <div className={styles.channelAgentLaneMembers}>
                {lane.members.length > 0
                  ? lane.members.slice(0, 3).map(({ id, info }) => (
                    <span key={id} title={info.displayName}>{info.displayName}</span>
                  ))
                  : <span>未配置</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`channel-info-section ${styles.channelDirectorPanel}`} aria-label="调度总监">
        <div className={styles.channelSectionHeaderRow}>
          <div>
            <div className="channel-info-label">调度总监</div>
            <div className={styles.channelDirectorSubtitle}>
              跨频道查看任务分派、Agent 当前状态、阻塞点和待复核输出。
            </div>
          </div>
          <span className={styles.channelDirectorBadge}>总监群监督 {directorSupervisors.length}</span>
        </div>
        <div className={styles.channelDirectorGrid}>
          <div className={styles.channelDirectorMetric}>
            <span>跨频道任务分派</span>
            <strong>{directorSummary.allTasks.length}</strong>
            <small>
              {directorSummary.assignedTasks.length} 已指派 · {directorSummary.crossChannelTasks.length} 跨频道
            </small>
          </div>
          <div className={styles.channelDirectorMetric}>
            <span>Agent 当前状态</span>
            <strong>{directorSummary.activeAgentCount}</strong>
            <small>{taskSummary.active} 个当前频道任务在推进</small>
          </div>
          <div className={styles.channelDirectorMetric}>
            <span>阻塞点</span>
            <strong>{directorSummary.blockedTasks.length}</strong>
            <small>
              {directorSummary.blockedTasks[0]
                ? `${taskTitle(directorSummary.blockedTasks[0])} · ${assignmentChannelLabel(directorSummary.blockedTasks[0])}`
                : '暂无阻塞'}
            </small>
          </div>
          <div className={styles.channelDirectorMetric}>
            <span>待复核输出</span>
            <strong>{directorSummary.reviewTasks.length}</strong>
            <small>
              {directorSummary.reviewTasks[0]
                ? `${taskTitle(directorSummary.reviewTasks[0])} · ${assignmentChannelLabel(directorSummary.reviewTasks[0])}`
                : '暂无待复核'}
            </small>
          </div>
        </div>
        <div className={styles.channelDirectorMembers} aria-label="总监监督成员">
          {directorSupervisors.length > 0 ? directorSupervisors.map(({ id, info, role }) => (
            <button
              key={id}
              type="button"
              className={styles.channelDirectorMember}
              data-director-supervisor-id={id}
              onClick={() => {
                const firstTask = scopedCompanyTasks.find((task) => task.assigneeAgentId === id);
                if (firstTask) focusTaskAndWorkflowNode(firstTask.id);
              }}
            >
              <span className={styles.channelMemberAvatar}>
                <MemberAvatar info={info} className={styles.channelMemberAvatarImg} />
              </span>
              <span>{info.displayName}</span>
              <small>{getChannelRoleLabel(role)}</small>
            </button>
          )) : (
            <div className={styles.channelDirectorEmpty}>暂无项目经理或管理员，总监群监督会使用第一个频道成员兜底。</div>
          )}
        </div>
      </div>

      <div ref={membersSectionRef} className="channel-info-section">
        <div className={styles.channelSectionHeaderRow}>
          <div className="channel-info-label">{localText('channel.taskTree', '任务树')}</div>
          <div className={styles.channelSectionActions}>
            <button
              type="button"
              className={styles.channelSecondaryAction}
              onClick={() => void loadCompanyStatus()}
              disabled={companyLoading}
            >
              {companyLoading ? localText('common.loading', '加载中') : localText('common.refresh', '刷新')}
            </button>
            <button
              type="button"
              className={`${styles.channelSecondaryAction} ${styles.channelDangerAction}`}
              onClick={() => void handleClearTaskTrees()}
              disabled={companyLoading || clearingTaskTrees || allTaskTrees.length === 0}
            >
              {clearingTaskTrees ? localText('common.loading', '加载中') : localText('channel.clearTaskTree', '清空')}
            </button>
          </div>
        </div>
        <div className={styles.channelTaskTreeNote}>
          任务树按频道绑定过滤；被 @ 的 Agent 会通过频道调度继续处理任务卡。
        </div>
        {companyError ? (
          <div className={styles.channelTaskTreeEmpty}>
            {localText('channel.companyUnavailable', '一人公司插件暂不可用')}
          </div>
        ) : scopedTaskTrees.length === 0 ? (
          <div className={styles.channelTaskTreeEmpty}>
            {companyLoading ? localText('common.loading', '加载中') : localText('channel.noCompanyTasks', '暂无任务卡')}
          </div>
        ) : (
          <div className={styles.channelTaskTreeList} ref={taskListRef}>
            {scopedTaskTrees.map((tree) => (
              <div key={tree.id} className={styles.channelTaskTree}>
                <div className={styles.channelTaskTreeHeader}>
                  <span>树 {tree.taskCount} 项</span>
                  <span>{tree.assigneeCount} 个 Agent</span>
                </div>
                {tree.roots.map((rootTask) => (
                  <TaskNode
                    key={rootTask.id}
                    task={rootTask}
                    agentMap={agentMap}
                    agents={agents}
                    currentAgentId={currentAgentId}
                    userName={userName}
                    userAvatarUrl={userAvatarUrl}
                    latestActivityByAgent={latestActivityByAgent}
                    focusedTaskId={focusedTaskId}
                    onFocusTask={focusTaskAndWorkflowNode}
                    root
                    depth={0}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="channel-info-section">
        <div className={styles.channelSectionHeaderRow}>
          <div className="channel-info-label">{localText('channel.members', '成员')}</div>
          <button
            type="button"
            className={styles.channelSecondaryAction}
            onClick={() => setFormOpen((open) => !open)}
          >
            {localText('channel.createAgent', '群内新建助手')}
          </button>
        </div>
        <div className={styles.channelWorkspaceMembers}>
          {teamMembers.map(({ id, info, role }) => (
            <div key={id} className={styles.channelWorkspaceMemberRow}>
              <div className={styles.channelWorkspaceMemberIdentity}>
                <span className={styles.channelMemberAvatar}>
                  <MemberAvatar info={info} className={styles.channelMemberAvatarImg} />
                </span>
                <div className={styles.channelWorkspaceMemberText}>
                  <div className={styles.channelMemberName} title={info.displayName}>{info.displayName}</div>
                  <div className={styles.channelWorkspaceMemberId} title={id}>{id}</div>
                </div>
              </div>
              <select
                className={styles.channelRoleSelect}
                value={role}
                title={getChannelRoleLabel(role)}
                disabled={savingRoleFor === id || removingMemberId === id}
                onChange={(e) => handleRoleChange(id, e.target.value as ChannelMemberRole)}
              >
                <option value="project_manager">{getChannelRoleLabel('project_manager')}</option>
                <option value="admin">{getChannelRoleLabel('admin')}</option>
                <option value="worker">{getChannelRoleLabel('worker')}</option>
              </select>
              <button
                type="button"
                className={styles.channelMemberRemoveButton}
                title={localText('channel.removeMember', '移除成员')}
                aria-label={localText('channel.removeMember', '移除成员')}
                disabled={!canRemoveMembers || removingMemberId === id}
                onClick={() => void handleRemoveMember(id, info.displayName)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {formOpen && (
        <div className="channel-info-section">
          <div className="channel-info-label">{localText('channel.createAgent', '群内新建助手')}</div>
          <div className={styles.channelAgentCreateForm}>
            <input
              className={styles.createInput}
              type="text"
              placeholder={localText('channel.createAgentNamePlaceholder', '助手名称')}
              value={agentName}
              onChange={(e) => {
                setAgentName(e.target.value);
                setAgentNameEdited(true);
              }}
            />
            <div className={styles.channelAgentCreateGrid}>
              <select
                className={styles.channelRoleSelect}
                value={agentYuan}
                onChange={(e) => setAgentYuan(e.target.value as (typeof YUAN_OPTIONS)[number])}
              >
                {YUAN_OPTIONS.map((key) => (
                  <option key={key} value={key}>
                    {yuanTypeDisplayName(key)}
                  </option>
                ))}
              </select>
              <select
                className={styles.channelRoleSelect}
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value as ChannelMemberRole)}
              >
                <option value="project_manager">{getChannelRoleLabel('project_manager')}</option>
                <option value="admin">{getChannelRoleLabel('admin')}</option>
                <option value="worker">{getChannelRoleLabel('worker')}</option>
              </select>
            </div>
            <div className={styles.channelAgentCreateActions}>
              <button
                type="button"
                className={styles.createCancel}
                onClick={() => setFormOpen(false)}
              >
                {localText('common.cancel', '取消')}
              </button>
              <button
                type="button"
                className={styles.createConfirm}
                disabled={creatingAgent || !agentName.trim()}
                onClick={handleCreateAgent}
              >
                {localText('channel.createAgentConfirm', '创建并加入')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskNode({
  task,
  agentMap,
  agents,
  currentAgentId,
  userName,
  userAvatarUrl,
  latestActivityByAgent,
  focusedTaskId,
  onFocusTask,
  root = false,
  depth,
}: {
  task: CompanyTaskNode;
  agentMap: ReturnType<typeof buildAgentMap>;
  agents: ReturnType<typeof useStore.getState>['agents'];
  currentAgentId: string | null;
  userName: string;
  userAvatarUrl: string | null;
  latestActivityByAgent: Record<string, AgentPhoneActivity | undefined>;
  focusedTaskId: string;
  onFocusTask: (taskId: string) => void;
  root?: boolean;
  depth: number;
}) {
  const assigneeId = task.assigneeAgentId || '';
  const info = assigneeId
    ? resolveChannelMember(assigneeId, userName, userAvatarUrl, agents, currentAgentId, agentMap)
    : null;
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.filter(Boolean) : [];
  const activity = assigneeId ? latestActivityByAgent[assigneeId] : undefined;
  const focused = focusedTaskId === task.id;
  return (
    <div
      className={`${styles.channelTaskNode}${root ? ` ${styles.channelTaskNodeRoot}` : ''}${focused ? ` ${styles.channelTaskNodeFocused}` : ''}`}
      data-task-depth={depth}
      data-company-task-id={task.id}
      role="button"
      tabIndex={0}
      aria-pressed={focused}
      onClick={(event) => {
        event.stopPropagation();
        onFocusTask(task.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onFocusTask(task.id);
        }
      }}
    >
      <div className={styles.channelTaskNodeTop}>
        <span className={`${styles.channelTaskStatus} ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
        <div className={styles.channelTaskTitle}>{taskTitle(task)}</div>
      </div>
      <div className={styles.channelTaskMeta}>
        {info && (
          <span className={styles.channelTaskAssignee}>
            <span className={styles.channelTaskAvatar}>
              <MemberAvatar info={info} className={styles.channelTaskAvatarImg} />
            </span>
            <span>{info.displayName}</span>
          </span>
        )}
        <span>{task.assigneeTitle || localText('channel.unassigned', '未分配')}</span>
      </div>
      {activity?.summary && (
        <div className={styles.channelTaskActivity}>{activity.summary}</div>
      )}
      {criteria.length > 0 && (
        <div className={styles.channelTaskCriteria}>
          {criteria.slice(0, 2).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
      {task.children.length > 0 && (
        <div className={styles.channelTaskChildren}>
          {task.children.map((child) => (
            <TaskNode
              key={child.id}
              task={child}
              agentMap={agentMap}
              agents={agents}
              currentAgentId={currentAgentId}
              userName={userName}
              userAvatarUrl={userAvatarUrl}
              latestActivityByAgent={latestActivityByAgent}
              focusedTaskId={focusedTaskId}
              onFocusTask={onFocusTask}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
