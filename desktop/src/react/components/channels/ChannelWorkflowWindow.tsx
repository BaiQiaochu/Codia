import { workflowTaskState, workflowRunState, isWorkflowRunActive, type WorkflowExecutionState } from '../../utils/workflow-run-state';
import { consumeWorkflowTemplateRequest, WORKFLOW_TEMPLATE_REQUEST_EVENT } from '../../utils/workflow-template-request';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { normalizeAgentActivityList, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import type { AgentPhoneActivity, ChannelMessage } from '../../types';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { resolveWorkflowWorkspaceKey, restoreLegacyHomeWorkflowDraft, workflowDraftStorageKey, workflowExecutionBindingKey } from '../../utils/workflow-workspace-storage';
import { createChannel, openChannel, toggleChannelsEnabled } from '../../stores/channel-actions';
import {
  validateWorkflowTemplateDraft,
  type WorkflowTemplateDraft,
} from '../../../../../shared/workflow-template-draft';
import {
  buildAgentMap,
  formatChannelTime,
  MemberAvatar,
  resolveChannelMember,
} from './channel-member-utils';
import styles from './Channels.module.css';

interface CompanyTask {
  report?: string;
  acceptanceFailure?: string;
  artifacts?: unknown[];
  source?: { nodeId?: string; runId?: string };
  id: string;
  treeId?: string;
  parentTaskId?: string;
  channelId?: string;
  title?: string;
  description?: string;
  assigneeAgentId?: string;
  status?: string;
  acceptanceCriteria?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface CompanyStatus {
  channels: Array<{ id: string; internalChannelId?: string }>;
  tasks: CompanyTask[];
}

interface WorkflowNode {
  id: string;
  kind: 'input' | 'scheduler' | 'agent' | 'task' | 'output';
  title: string;
  subtitle: string;
  meta?: string;
  state: 'idle' | 'running' | 'done' | 'blocked' | 'error';
  x: number;
  y: number;
  w: number;
  h: number;
  agentId?: string;
  taskId?: string;
  custom?: boolean;
}

interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  state: WorkflowNode['state'];
}

interface CustomWorkflowNode {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  x: number;
  y: number;
}

interface CustomWorkflowEdge {
  id: string;
  from: string;
  to: string;
}

interface WorkflowLayoutPosition {
  x: number;
  y: number;
}

type WorkflowLayoutMap = Record<string, WorkflowLayoutPosition>;

interface WorkflowNodeDrag {
  type: 'node';
  pointerId: number;
  nodeId: string;
  originX: number;
  originY: number;
  startClientX: number;
  startClientY: number;
  nodeW: number;
  nodeH: number;
  moved: boolean;
}

interface WorkflowEdgeDrag {
  type: 'edge';
  pointerId: number;
  fromNodeId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface WorkflowCanvasPan {
  type: 'canvas';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originScrollLeft: number;
  originScrollTop: number;
  moved: boolean;
}

type WorkflowInteraction = WorkflowNodeDrag | WorkflowEdgeDrag | WorkflowCanvasPan | null;

interface WorkflowResourceEventDetail {
  channelId?: string;
  fileId?: string;
  name?: string;
  path?: string;
  kind?: string;
  mime?: string;
}

interface WorkflowStage {
  key: string;
  label: string;
  value: string;
  state: WorkflowNode['state'];
}

interface WorkflowTimelineItem {
  id: string;
  nodeId: string;
  time: string;
  label: string;
  agentName?: string;
  input?: string;
  output?: string;
  failure?: string;
  retryState?: WorkflowRetryState;
  state: WorkflowNode['state'];
}

type WorkflowRetryState = 'not_started' | 'retrying' | WorkflowExecutionState;

interface WorkflowRunNodeSnapshot {
  nodeId: string;
  taskId?: string;
  label: string;
  agentId?: string;
  agentName?: string;
  input: string;
  output: string;
  failure?: string;
  state: WorkflowNode['state'];
  retryState: WorkflowRetryState;
  triggeredAt: string;
}

interface WorkflowRunSnapshot {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: WorkflowExecutionState;
  failure?: string;
  nodes: WorkflowRunNodeSnapshot[];
}

const NODE_W = 210;
const NODE_H = 92;
const AGENT_NODE_H = 104;
const TASK_NODE_W = 230;
const TASK_NODE_H = 88;
const WORKFLOW_CANVAS_BASE_W = 6400;
const WORKFLOW_CANVAS_BASE_H = 4200;
const WORKFLOW_CANVAS_EXPAND_MARGIN = 1400;
const WORKFLOW_ZOOM_MIN = 0.5;
const WORKFLOW_ZOOM_MAX = 1.5;
const WORKFLOW_ZOOM_STEP = 0.1;
const WORKFLOW_STORAGE_PREFIX = 'codia.channel.workflow.';
const EMPTY_ACTIVITY_ENTRIES: AgentActivityEntry[] = [];
const EMPTY_CHANNEL_MESSAGES: ChannelMessage[] = [];

function workflowStorageKey(channelId: string) {
  return `${WORKFLOW_STORAGE_PREFIX}${channelId}`;
}

function parseStoredWorkflow(value: string | null): {
  nodes: CustomWorkflowNode[];
  edges: CustomWorkflowEdge[];
  snapshots: WorkflowRunSnapshot[];
  layout: WorkflowLayoutMap;
  hiddenTimelineItemIds: string[];
} {
  if (!value) return { nodes: [], edges: [], snapshots: [], layout: {}, hiddenTimelineItemIds: [] };
  try {
    const parsed = JSON.parse(value);
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];
    const snapshots = Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
    const layoutEntries = parsed?.layout && typeof parsed.layout === 'object'
      ? Object.entries(parsed.layout as Record<string, Partial<WorkflowLayoutPosition>>)
      : [];
    const hiddenTimelineItemIds = Array.isArray(parsed?.hiddenTimelineItemIds)
      ? parsed.hiddenTimelineItemIds.filter((id: unknown) => typeof id === 'string' && id).slice(0, 200)
      : [];
    return {
      nodes: nodes
        .filter((node: Partial<CustomWorkflowNode>) => typeof node?.id === 'string' && node.id)
        .map((node: Partial<CustomWorkflowNode>, index: number) => ({
          id: String(node.id),
          title: String(node.title || `自定义任务 ${index + 1}`),
          prompt: String(node.prompt || ''),
          agentId: String(node.agentId || ''),
          x: Number.isFinite(node.x) ? Number(node.x) : 312 + (index % 2) * 254,
          y: Number.isFinite(node.y) ? Number(node.y) : 248 + Math.floor(index / 2) * 112,
        })),
      edges: edges
        .filter((edge: Partial<CustomWorkflowEdge>) => typeof edge?.from === 'string' && typeof edge?.to === 'string')
        .map((edge: Partial<CustomWorkflowEdge>, index: number) => ({
          id: String(edge.id || `custom-edge-${index + 1}`),
          from: String(edge.from),
          to: String(edge.to),
        })),
      snapshots: snapshots
        .filter((snapshot: Partial<WorkflowRunSnapshot>) => typeof snapshot?.id === 'string' && Array.isArray(snapshot.nodes))
        .slice(0, 20)
        .map((snapshot: Partial<WorkflowRunSnapshot>) => ({
          id: String(snapshot.id),
          startedAt: String(snapshot.startedAt || ''),
          ...(snapshot.finishedAt ? { finishedAt: String(snapshot.finishedAt) } : {}),
          status: ['queued', 'running', 'awaiting_approval', 'partial_failure', 'succeeded', 'failed', 'cancelled'].includes(String(snapshot.status)) ? snapshot.status as WorkflowExecutionState : 'queued',
          ...(snapshot.failure ? { failure: String(snapshot.failure) } : {}),
          nodes: (snapshot.nodes || []).filter((node: Partial<WorkflowRunNodeSnapshot>) => typeof node?.nodeId === 'string').map((node: Partial<WorkflowRunNodeSnapshot>) => ({
            nodeId: String(node.nodeId),
            ...(node.taskId ? { taskId: String(node.taskId) } : {}),
            label: String(node.label || node.nodeId),
            ...(node.agentId ? { agentId: String(node.agentId) } : {}),
            ...(node.agentName ? { agentName: String(node.agentName) } : {}),
            input: String(node.input || ''),
            output: String(node.output || ''),
            ...(node.failure ? { failure: String(node.failure) } : {}),
            state: ['running', 'done', 'blocked', 'error', 'idle'].includes(String(node.state)) ? node.state as WorkflowNode['state'] : 'idle',
            retryState: ['not_started', 'queued', 'running', 'awaiting_approval', 'retrying', 'succeeded', 'failed', 'cancelled'].includes(String(node.retryState))
              ? node.retryState as WorkflowRetryState
              : 'not_started',
            triggeredAt: String(node.triggeredAt || snapshot.startedAt || ''),
          })),
        })),
      layout: Object.fromEntries(
        layoutEntries
          .filter(([nodeId, position]) => (
            typeof nodeId === 'string'
            && nodeId
            && Number.isFinite(position?.x)
            && Number.isFinite(position?.y)
          ))
          .map(([nodeId, position]) => [nodeId, { x: Number(position.x), y: Number(position.y) }]),
      ),
      hiddenTimelineItemIds,
    };
  } catch {
    return { nodes: [], edges: [], snapshots: [], layout: {}, hiddenTimelineItemIds: [] };
  }
}

function persistStoredWorkflow(
  channelId: string,
  value: {
    nodes: CustomWorkflowNode[];
    edges: CustomWorkflowEdge[];
    snapshots?: WorkflowRunSnapshot[];
    layout?: WorkflowLayoutMap;
    hiddenTimelineItemIds?: string[];
  },
) {
  const snapshots = Array.isArray(value.snapshots) ? value.snapshots.slice(0, 20) : [];
  const hiddenTimelineItemIds = uniqueStrings(value.hiddenTimelineItemIds || []).slice(0, 200);
  const layout = Object.fromEntries(
    Object.entries(value.layout || {}).filter(([, position]) => (
      Number.isFinite(position.x) && Number.isFinite(position.y)
    )),
  );
  if (
    value.nodes.length === 0
    && value.edges.length === 0
    && snapshots.length === 0
    && hiddenTimelineItemIds.length === 0
    && Object.keys(layout).length === 0
  ) {
    window.localStorage?.removeItem(channelId.startsWith(WORKFLOW_STORAGE_PREFIX) ? channelId : workflowStorageKey(channelId));
    return;
  }
  window.localStorage?.setItem(
    channelId.startsWith(WORKFLOW_STORAGE_PREFIX) ? channelId : workflowStorageKey(channelId),
    JSON.stringify({ nodes: value.nodes, edges: value.edges, snapshots, layout, hiddenTimelineItemIds }),
  );
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function applyTemplateDraftToCanvas({
  draft,
  mode,
  existingNodes,
  existingEdges,
}: {
  draft: WorkflowTemplateDraft;
  mode: 'merge' | 'replace';
  existingNodes: CustomWorkflowNode[];
  existingEdges: CustomWorkflowEdge[];
}) {
  const baseNodes = mode === 'merge' ? existingNodes : [];
  const baseEdges = mode === 'merge' ? existingEdges : [];
  const occupiedIds = new Set(baseNodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const seed = Date.now().toString(36);
  const startY = mode === 'merge' && baseNodes.length > 0
    ? Math.max(248, ...baseNodes.map((node) => node.y + 116))
    : 248;
  const nodes = draft.nodes.map((node, index): CustomWorkflowNode => {
    let id = `template-${seed}-${index + 1}`;
    let suffix = 1;
    while (occupiedIds.has(id)) {
      suffix += 1;
      id = `template-${seed}-${index + 1}-${suffix}`;
    }
    occupiedIds.add(id);
    idMap.set(node.id, id);
    return {
      id,
      title: node.title,
      prompt: node.prompt,
      agentId: node.agentId,
      x: 312 + (index % 2) * 254,
      y: startY + Math.floor(index / 2) * 112,
    };
  });
  const edges = draft.edges.map((edge, index): CustomWorkflowEdge => {
    const from = idMap.get(edge.from)!;
    const to = idMap.get(edge.to)!;
    return {
      id: `custom-edge-${from}-${to}-${index + 1}`,
      from,
      to,
    };
  });
  return {
    nodes: [...baseNodes, ...nodes],
    edges: [...baseEdges, ...edges],
    firstNodeId: nodes[0]?.id || '',
  };
}

function detailText(value: unknown, fallback = '暂无') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function activitySessionPath(activity: AgentPhoneActivity | undefined): string | null {
  const value = activity?.details?.sessionPath;
  return typeof value === 'string' && value ? value : null;
}

function channelWorkflowActivitySessionPath(channelId: string | null | undefined): string | null {
  const value = String(channelId || '').trim();
  return value ? `channel:${value}` : null;
}

function workflowActivityTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'pending';
  const iso = new Date(value).toISOString();
  return formatChannelTime(`${iso.slice(0, 10)} ${iso.slice(11, 19)}`);
}

function workflowActivityState(status: AgentActivityEntry['status']): WorkflowNode['state'] {
  if (status === 'done') return 'done';
  if (status === 'failed' || status === 'aborted') return 'error';
  return 'running';
}

function workflowActivityRetryState(status: AgentActivityEntry['status']): WorkflowRetryState {
  if (status === 'done') return 'succeeded';
  if (status === 'failed' || status === 'aborted') return 'failed';
  return 'running';
}

function workflowActivityNodeId(activity: AgentActivityEntry): string {
  const parent = activity.parentTaskId || '';
  const prefix = parent ? `${parent}::` : '';
  if (prefix && activity.id.startsWith(prefix)) return activity.id.slice(prefix.length) || activity.id;
  return activity.id;
}

function activityHubTimelineItems(activities: AgentActivityEntry[]): WorkflowTimelineItem[] {
  return activities
    .filter((activity) => activity.kind === 'workflow_agent' || activity.kind === 'workflow_step')
    .slice(0, 80)
    .map((activity) => {
      const failed = activity.status === 'failed' || activity.status === 'aborted';
      return {
        id: `activity:${activity.id}`,
        nodeId: workflowActivityNodeId(activity),
        time: workflowActivityTime(activity.startedAt || activity.finishedAt),
        label: detailText(activity.label || activity.phaseLabel || activity.summary || activity.id, 'Workflow activity'),
        agentName: activity.agentName || activity.agentId || undefined,
        input: detailText(activity.phaseLabel, 'ActivityHub'),
        output: detailText(activity.summary, activity.status),
        failure: failed ? detailText(activity.summary, activity.status) : undefined,
        retryState: workflowActivityRetryState(activity.status),
        state: workflowActivityState(activity.status),
      };
    });
}

function statusText(status?: string) {
  const map: Record<string, string> = {
    assigned: '已分派',
    queued: '已排队',
    cancelled: '已取消',
    awaiting_approval: '等待审批',
    in_progress: '执行中',
    reported: '已回报',
    completed: '已完成',
    blocked: '受阻',
    failed: '失败',
  };
  return map[String(status || 'assigned')] || String(status || 'assigned');
}

function taskState(status?: string): WorkflowNode['state'] {
  const key = String(status || 'assigned');
  if (key === 'completed') return 'done';
  if (key === 'blocked' || key === 'awaiting_approval' || key === 'cancelled') return 'blocked';
  if (key === 'failed') return 'error';
  if (key === 'in_progress' || key === 'reported') return 'running';
  return 'idle';
}

function isBlockedTask(task: CompanyTask) {
  const status = String(task.status || 'assigned');
  return status === 'blocked' || status === 'failed';
}

function isReviewTask(task: CompanyTask) {
  return String(task.status || '') === 'reported';
}

function activityState(activity: AgentPhoneActivity | undefined): WorkflowNode['state'] {
  const state = String(activity?.state || '');
  if (!state) return 'idle';
  if (state === 'error') return 'error';
  if (state === 'waiting_permission') return 'blocked';
  if (state === 'idle' || state === 'no_reply') return 'done';
  return 'running';
}

function latestActivitySummary(activity: AgentPhoneActivity | undefined) {
  if (!activity) return '等待频道调度';
  const time = activity.timestamp ? formatChannelTime(activity.timestamp) : '';
  return [activity.summary || activity.state, time].filter(Boolean).join(' · ');
}

function channelScopeIds(currentChannel: string, channels: CompanyStatus['channels']) {
  const ids = new Set([currentChannel]);
  for (const channel of channels) {
    if (channel.id === currentChannel || channel.internalChannelId === currentChannel) {
      ids.add(channel.id);
      if (channel.internalChannelId) ids.add(channel.internalChannelId);
    }
  }
  return ids;
}

function edgePath(from: WorkflowNode, to: WorkflowNode) {
  const startX = from.x + from.w;
  const startY = from.y + from.h / 2;
  const endX = to.x;
  const endY = to.y + to.h / 2;
  const dx = Math.max(80, (endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
}

function edgePreviewPath(startX: number, startY: number, endX: number, endY: number) {
  const dx = Math.max(60, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function nodeStateLabel(state: WorkflowNode['state']) {
  const map: Record<WorkflowNode['state'], string> = {
    idle: '等待',
    running: '运行',
    done: '完成',
    blocked: '受阻',
    error: '异常',
  };
  return map[state];
}

function nodeKindLabel(kind: WorkflowNode['kind']) {
  const map: Record<WorkflowNode['kind'], string> = {
    input: '输入',
    scheduler: '调度',
    agent: 'Agent',
    task: '任务',
    output: '回报',
  };
  return map[kind];
}

function dominantState(states: WorkflowNode['state'][]): WorkflowNode['state'] {
  if (states.includes('error')) return 'error';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('running')) return 'running';
  if (states.includes('done')) return 'done';
  return 'idle';
}

function WorkflowNodeCard({
  node,
  agents,
  currentAgentId,
  userName,
  userAvatarUrl,
  agentMap,
  selected,
  connectTarget,
  dragging,
  onClick,
  onPointerDown,
  onStartConnectDrag,
}: {
  node: WorkflowNode;
  agents: ReturnType<typeof useStore.getState>['agents'];
  currentAgentId: string | null;
  userName: string;
  userAvatarUrl: string | null;
  agentMap: ReturnType<typeof buildAgentMap>;
  selected: boolean;
  connectTarget: boolean;
  dragging: boolean;
  onClick: (node: WorkflowNode) => void;
  onPointerDown: (node: WorkflowNode, event: ReactPointerEvent<HTMLDivElement>) => void;
  onStartConnectDrag: (node: WorkflowNode, event: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  const info = node.agentId
    ? resolveChannelMember(node.agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap)
    : null;
  const className = [
    styles.workflowNode,
    selected ? styles.workflowNodeSelected : '',
    connectTarget ? styles.workflowNodeConnectTarget : '',
    dragging ? styles.workflowNodeDragging : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      className={className}
      data-workflow-node-id={node.id}
      data-company-task-id={node.taskId}
      data-kind={node.kind}
      data-state={node.state}
      data-custom={node.custom ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onClick(node)}
      onPointerDown={(event) => onPointerDown(node, event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(node);
        }
      }}
      style={{ left: node.x, top: node.y, width: node.w, minHeight: node.h }}
    >
      <span
        className={`${styles.workflowNodePort} ${styles.workflowNodePortIn}`}
        data-workflow-port="in"
        aria-hidden="true"
      />
      <span
        className={`${styles.workflowNodePort} ${styles.workflowNodePortOut}`}
        data-workflow-port="out"
        aria-hidden="true"
        onPointerDown={(event) => onStartConnectDrag(node, event)}
      />
      <div className={styles.workflowNodeTop}>
        {info && (
          <span className={styles.workflowNodeAvatar}>
            <MemberAvatar info={info} className={styles.workflowNodeAvatarImg} />
          </span>
        )}
        <div className={styles.workflowNodeTitleWrap}>
          <div className={styles.workflowNodeKind}>{nodeKindLabel(node.kind)}</div>
          <div className={styles.workflowNodeTitle}>{node.title}</div>
          <div className={styles.workflowNodeSubtitle}>{node.subtitle}</div>
        </div>
        <span className={styles.workflowNodeState}>{nodeStateLabel(node.state)}</span>
      </div>
      {node.meta && <div className={styles.workflowNodeMeta}>{node.meta}</div>}
    </div>
  );
}

export function ChannelWorkflowWindow({ open, onClose, pageMode = false, standalone = false }: {
  open: boolean;
  onClose: () => void;
  pageMode?: boolean;
  standalone?: boolean;
}) {
  const currentChannel = useStore(s => s.currentChannel);
  const channels = useStore(s => s.channels);
  const agents = useStore(s => s.agents);
  const storeChannelMembers = useStore(s => s.channelMembers);
  const storeChannelMemberRoles = useStore(s => s.channelMemberRoles);
  const storeChannelHeaderName = useStore(s => s.channelHeaderName);
  const channelsEnabled = useStore(s => s.channelsEnabled);
  const selectedFolder = useStore(s => s.selectedFolder);
  const selectedWorkspaceMountId = useStore(s => s.selectedWorkspaceMountId);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const homeFolder = useStore(s => s.homeFolder);
  // selectedFolder is a pending new-session choice, not a durable workspace:
  // switching to an existing chat clears it. Keep the actual workspace scope.
  const workflowWorkspaceKey = resolveWorkflowWorkspaceKey({
    selectedWorkspaceMountId, selectedFolder, deskWorkspaceMountId, deskBasePath, homeFolder,
  });
  const executionBindingKey = workflowExecutionBindingKey(workflowWorkspaceKey);
  const [executionChannelId, setExecutionChannelId] = useState(() => standalone ? localStorage.getItem(executionBindingKey) || '' : '');
  const [executionSetupOpen, setExecutionSetupOpen] = useState(false);
  const [executionChannelName, setExecutionChannelName] = useState('');
  const [executionMembers, setExecutionMembers] = useState<string[]>([]);
  const [executionError, setExecutionError] = useState('');
  const [executionSetupBusy, setExecutionSetupBusy] = useState(false);
  const workflowChannelId = standalone ? executionChannelId : currentChannel;
  const workflowScopeKey = standalone
    ? workflowDraftStorageKey(workflowWorkspaceKey)
    : currentChannel ? workflowStorageKey(currentChannel) : '';
  useEffect(() => {
    if (standalone && open && !selectedWorkspaceMountId && !deskWorkspaceMountId) {
      restoreLegacyHomeWorkflowDraft(localStorage, workflowWorkspaceKey, homeFolder);
    }
    setExecutionChannelId(standalone ? localStorage.getItem(executionBindingKey) || '' : '');
  }, [deskWorkspaceMountId, executionBindingKey, homeFolder, open, selectedWorkspaceMountId, standalone, workflowWorkspaceKey]);
  const scopedChannel = channels.find(channel => channel.id === workflowChannelId && !channel.isDM);
  const workflowChannelMembers = standalone
    ? scopedChannel?.members || []
    : storeChannelMembers;
  const workflowChannelMemberRoles = standalone
    ? scopedChannel?.memberRoles || {}
    : storeChannelMemberRoles;
  const workflowChannelName = standalone
    ? scopedChannel?.name || (workflowChannelId ? `# ${workflowChannelId}` : '独立工作流草稿')
    : storeChannelHeaderName;
  const workflowActivitySessionPath = channelWorkflowActivitySessionPath(workflowChannelId || null);
  const channelWorkflowActivities = useStore(s => (
    workflowActivitySessionPath
      ? normalizeAgentActivityList(s.agentActivitiesBySession[workflowActivitySessionPath])
      : EMPTY_ACTIVITY_ENTRIES
  ));
  // Zustand requires selector snapshots to stay referentially stable when the
  // selected value hasn't changed. A fresh [] here causes an infinite React
  // update loop for standalone drafts while another channel is selected.
  const channelMessages = useStore(s => s.currentChannel === workflowChannelId ? s.channelMessages : EMPTY_CHANNEL_MESSAGES);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const currentAgentId = useStore(s => s.currentAgentId);
  const allActivities = useStore(s => s.channelAgentActivities);
  const tickerStatuses = useStore(s => s.channelTickerStatus);
  const addToast = useStore(s => s.addToast);
  const pendingChannelResourceAction = useStore(s => s.pendingChannelResourceAction);
  const consumePendingChannelResourceAction = useStore(s => s.consumePendingChannelResourceAction);
  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);
  const currentWorkflowScopeRef = useRef(workflowScopeKey);
  currentWorkflowScopeRef.current = workflowScopeKey;
  const [companyStatus, setCompanyStatus] = useState<CompanyStatus | null>(null);
  const [companyError, setCompanyError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [triggering, setTriggering] = useState(false);
  const dispatchRunRef = useRef<string | null>(null);
  const cancelledRunIdsRef = useRef(new Set<string>());
  const [cancellingRun, setCancellingRun] = useState(false);
  const [customWorkflowNodes, setCustomWorkflowNodes] = useState<CustomWorkflowNode[]>([]);
  const [customWorkflowEdges, setCustomWorkflowEdges] = useState<CustomWorkflowEdge[]>([]);
  const [workflowRunSnapshots, setWorkflowRunSnapshots] = useState<WorkflowRunSnapshot[]>([]);
  const [workflowNodeLayout, setWorkflowNodeLayout] = useState<WorkflowLayoutMap>({});
  const [hiddenTimelineItemIds, setHiddenTimelineItemIds] = useState<string[]>([]);
  const [workflowReplayItemId, setWorkflowReplayItemId] = useState('');
  const [workflowReplayPlaying, setWorkflowReplayPlaying] = useState(false);
  const [workflowReplayRerunning, setWorkflowReplayRerunning] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [connectFromNodeId, setConnectFromNodeId] = useState('');
  const [workflowInteraction, setWorkflowInteractionState] = useState<WorkflowInteraction>(null);
  const [loadedWorkflowScopeKey, setLoadedWorkflowScopeKey] = useState<string | null>(null);
  const [restoredWorkflowDraft, setRestoredWorkflowDraft] = useState(false);
  const [channelToggleBusy, setChannelToggleBusy] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateDraft, setTemplateDraft] = useState<WorkflowTemplateDraft | null>(null);
  const [templateApplyMode, setTemplateApplyMode] = useState<'merge' | 'replace'>('merge');
  const [templateGenerating, setTemplateGenerating] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const latestWorkflowNodesRef = useRef<WorkflowNode[]>([]);
  const customNodeIdsRef = useRef<Set<string>>(new Set());
  const workflowInteractionRef = useRef<WorkflowInteraction>(null);
  const suppressNodeClickRef = useRef(false);
  const templateRequestIdRef = useRef(0);
  const templateAbortControllerRef = useRef<AbortController | null>(null);
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const templateDialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    templateRequestIdRef.current += 1;
    templateAbortControllerRef.current?.abort();
    templateAbortControllerRef.current = null;
    setTemplateDialogOpen(false);
    setTemplateGenerating(false);
  }, [workflowScopeKey]);

  useEffect(() => () => {
    templateRequestIdRef.current += 1;
    templateAbortControllerRef.current?.abort();
  }, []);

  const workflowTemplateAgents = useMemo(() => {
    const memberIds = workflowChannelMembers.length
      ? workflowChannelMembers
      : agents.map((agent) => agent.id);
    return uniqueStrings(memberIds).map((id) => ({
      id,
      name: resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId, agentMap).displayName,
    }));
  }, [agentMap, agents, currentAgentId, userAvatarUrl, userName, workflowChannelMembers]);

  const setWorkflowInteraction = useCallback((next: WorkflowInteraction) => {
    workflowInteractionRef.current = next;
    setWorkflowInteractionState(next);
  }, []);

  const loadCompanyStatus = useCallback(async () => {
    if (!open || !workflowChannelId) return;
    setCompanyError('');
    try {
      const res = await codiaFetch('/api/plugins/company/companies/default/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (currentWorkflowScopeRef.current !== workflowScopeKey) return;
      setCompanyStatus({
        channels: Array.isArray(data.channels) ? data.channels : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      });
    } catch (err) {
      if (currentWorkflowScopeRef.current === workflowScopeKey) setCompanyError(err instanceof Error ? err.message : String(err));
    }
  }, [open, workflowChannelId, workflowScopeKey]);

  useEffect(() => {
    if (!open) return;
    void loadCompanyStatus();
  }, [loadCompanyStatus, open]);

  useEffect(() => {
    if (open) setZoom(1);
  }, [open, workflowChannelId]);

  useEffect(() => {
    setConnectFromNodeId('');
    setSelectedNodeId('');
    if (!open || !workflowScopeKey) {
      setCustomWorkflowNodes([]);
      setCustomWorkflowEdges([]);
      setWorkflowRunSnapshots([]);
      setWorkflowNodeLayout({});
      setHiddenTimelineItemIds([]);
      setWorkflowInteraction(null);
      setLoadedWorkflowScopeKey(null);
      setRestoredWorkflowDraft(false);
      return;
    }
    const stored = parseStoredWorkflow(window.localStorage?.getItem(workflowScopeKey) || null);
    setCustomWorkflowNodes(stored.nodes);
    setCustomWorkflowEdges(stored.edges);
    setWorkflowRunSnapshots(stored.snapshots);
    setWorkflowNodeLayout(stored.layout);
    setHiddenTimelineItemIds(stored.hiddenTimelineItemIds);
    setRestoredWorkflowDraft(stored.nodes.length > 0 || stored.edges.length > 0);
    setLoadedWorkflowScopeKey(workflowScopeKey);
  }, [open, setWorkflowInteraction, workflowScopeKey]);

  useEffect(() => {
    // A scope change renders once with the previous canvas state. Persist only
    // after the nodes, edges and layout have been restored for this exact key.
    if (!open || !workflowScopeKey || loadedWorkflowScopeKey !== workflowScopeKey) return;
    persistStoredWorkflow(workflowScopeKey, {
      nodes: customWorkflowNodes,
      edges: customWorkflowEdges,
      snapshots: workflowRunSnapshots,
      layout: workflowNodeLayout,
      hiddenTimelineItemIds,
    });
  }, [customWorkflowEdges, customWorkflowNodes, hiddenTimelineItemIds, loadedWorkflowScopeKey, open, workflowNodeLayout, workflowRunSnapshots, workflowScopeKey]);

  const scopedCompanyTasks = useMemo(() => {
    if (!workflowChannelId) return [] as CompanyTask[];
    const scopedIds = channelScopeIds(workflowChannelId, companyStatus?.channels || []);
    return (companyStatus?.tasks || []).filter((task) => {
      const taskChannelId = task.channelId || '';
      return !taskChannelId || scopedIds.has(taskChannelId);
    });
  }, [companyStatus, workflowChannelId]);

  const activeWorkflowRun = workflowRunSnapshots.find(run => isWorkflowRunActive(run.status));
  useEffect(() => {
    if (!open || !activeWorkflowRun) return;
    const timer = window.setInterval(() => void loadCompanyStatus(), 2000);
    return () => window.clearInterval(timer);
  }, [open, activeWorkflowRun?.id, loadCompanyStatus]);

  useEffect(() => {
    if (!companyStatus) return;
    setWorkflowRunSnapshots(runs => runs.map(run => {
      if (!isWorkflowRunActive(run.status)) return run;
      const nodes = run.nodes.map(node => {
        const task = companyStatus.tasks.find(task => task.id === node.taskId || (task.source?.runId === run.id && task.source?.nodeId === node.nodeId));
        if (!task) return node;
        const retryState = workflowTaskState(task.status);
        const state: WorkflowNode['state'] = retryState === 'succeeded' ? 'done' : retryState === 'failed' ? 'error' : retryState === 'awaiting_approval' || retryState === 'cancelled' ? 'blocked' : retryState === 'running' ? 'running' : 'idle';
        return { ...node, taskId: task.id, retryState, state,
          output: task.acceptanceFailure || task.report || (task.artifacts?.length ? JSON.stringify(task.artifacts) : '等待任务结果'),
          failure: retryState === 'failed' ? task.report || '任务失败' : undefined };
      });
      const status = workflowRunState(nodes.map(node => node.retryState === 'not_started' || node.retryState === 'retrying' ? 'queued' : node.retryState));
      return { ...run, nodes, status, ...(!isWorkflowRunActive(status) ? { finishedAt: new Date().toISOString() } : {}) };
    }));
  }, [companyStatus]);

  const customNodeIds = useMemo(() => new Set(customWorkflowNodes.map((node) => node.id)), [customWorkflowNodes]);
  useEffect(() => {
    customNodeIdsRef.current = customNodeIds;
  }, [customNodeIds]);

  const selectedCustomNode = useMemo(
    () => customWorkflowNodes.find((node) => node.id === selectedNodeId) || null,
    [customWorkflowNodes, selectedNodeId],
  );
  const workflowPlan = useMemo(() => ({
    id: `workflow:${workflowChannelId || workflowWorkspaceKey}`,
    title: workflowChannelName || '独立工作流草稿',
    supervision: {
      mode: 'director_group',
      supervisorAgentIds: uniqueStrings(workflowChannelMembers.filter((agentId, index) => {
        const role = workflowChannelMemberRoles[agentId];
        return role === 'project_manager' || role === 'admin' || (!role && index === 0);
      })),
    },
    nodes: customWorkflowNodes.map((node) => ({
      id: node.id,
      title: node.title,
      prompt: node.prompt,
      assigneeAgentId: node.agentId,
      kind: 'task',
    })),
    edges: customWorkflowEdges
      .filter((edge) => customNodeIds.has(edge.from) && customNodeIds.has(edge.to))
      .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })),
  }), [customNodeIds, customWorkflowEdges, customWorkflowNodes, workflowChannelId, workflowChannelMemberRoles, workflowChannelMembers, workflowChannelName, workflowWorkspaceKey]);
  const mentionedAgents = useMemo(
    () => uniqueStrings([
      ...customWorkflowNodes.map((node) => node.agentId),
      ...workflowPlan.supervision.supervisorAgentIds,
    ]),
    [customWorkflowNodes, workflowPlan.supervision.supervisorAgentIds],
  );
  const hasDispatchableWorkflow = scopedCompanyTasks.some(task => !['completed', 'failed', 'cancelled'].includes(task.status || '')) || customWorkflowNodes.length > 0;

  const updateCustomWorkflowNode = useCallback((nodeId: string, patch: Partial<CustomWorkflowNode>) => {
    setCustomWorkflowNodes((nodes) => nodes.map((node) => (
      node.id === nodeId ? { ...node, ...patch } : node
    )));
  }, []);

  const handleAddWorkflowNode = useCallback(() => {
    const nodeId = `custom-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCustomWorkflowNodes((nodes) => {
      const index = nodes.length + 1;
      const availableMembers = workflowChannelMembers.length ? workflowChannelMembers : agents.map(agent => agent.id);
      const agentId = availableMembers[(index - 1) % Math.max(1, availableMembers.length)] || '';
      const node: CustomWorkflowNode = {
        id: nodeId,
        title: `自定义任务 ${index}`,
        prompt: '填写这个节点要交给智能体完成的任务',
        agentId,
        x: 312 + ((index - 1) % 2) * 254,
        y: 248 + Math.floor((index - 1) / 2) * 112,
      };
      return [...nodes, node];
    });
    setSelectedNodeId(nodeId);
    setConnectFromNodeId('');
    setRestoredWorkflowDraft(false);
  }, [agents, workflowChannelMembers]);

  const handleCloseTemplateGenerator = useCallback(() => {
    templateRequestIdRef.current += 1;
    templateAbortControllerRef.current?.abort();
    templateAbortControllerRef.current = null;
    setTemplateGenerating(false);
    setTemplateDialogOpen(false);
  }, []);

  const handleOpenTemplateGenerator = useCallback(() => {
    templateRequestIdRef.current += 1;
    templateAbortControllerRef.current?.abort();
    templateAbortControllerRef.current = null;
    setTemplateDialogOpen(true);
    setTemplateDraft(null);
    setTemplateError('');
    setTemplateApplyMode(customWorkflowNodes.length > 0 ? 'merge' : 'replace');
  }, [customWorkflowNodes.length]);

  useEffect(() => {
    if (!templateDialogOpen) return undefined;
    const dialog = templateDialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = templateTriggerRef.current
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const backdrop = dialog.parentElement;
    const panel = backdrop?.parentElement;
    const siblingState = panel && backdrop
      ? Array.from(panel.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
        .map((element) => ({
          element,
          hadInert: element.hasAttribute('inert'),
          ariaHidden: element.getAttribute('aria-hidden'),
        }))
      : [];
    siblingState.forEach(({ element }) => {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    });

    const focusableSelector = [
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusFirst = window.requestAnimationFrame(() => {
      (dialog.querySelector('textarea') as HTMLElement | null
        || dialog.querySelector(focusableSelector) as HTMLElement | null
        || dialog).focus();
    });
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      dialog.removeEventListener('keydown', handleDialogKeyDown);
      siblingState.forEach(({ element, hadInert, ariaHidden }) => {
        if (!hadInert) element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [templateDialogOpen]);

  const handleGenerateWorkflowTemplate = useCallback(async (initialDescription?: string) => {
    const description = (initialDescription ?? templateDescription).trim();
    if (!description) {
      setTemplateError('请先描述希望创建的工作流。');
      return;
    }
    templateAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    templateAbortControllerRef.current = abortController;
    const requestId = ++templateRequestIdRef.current;
    setTemplateGenerating(true);
    setTemplateError('');
    try {
      const response = await codiaFetch('/api/workspace-tools/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          workspaceTool: { id: 'workflow-market' },
          action: 'generate_workflow_template',
          agentId: currentAgentId,
          input: {
            description,
            agents: workflowTemplateAgents,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      }
      if (requestId !== templateRequestIdRef.current) return;
      const validation = validateWorkflowTemplateDraft(data?.draft, {
        allowedAgentIds: workflowTemplateAgents.map((agent) => agent.id),
      });
      if (validation.ok === false) throw new Error(validation.error);
      setTemplateDraft(validation.draft);
    } catch (error) {
      if (requestId !== templateRequestIdRef.current) return;
      setTemplateDraft(null);
      setTemplateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === templateRequestIdRef.current) {
        templateAbortControllerRef.current = null;
        setTemplateGenerating(false);
      }
    }
  }, [currentAgentId, templateDescription, workflowTemplateAgents]);

  useEffect(() => {
    if (!open || !standalone) return;
    const receive = () => {
      const description = consumeWorkflowTemplateRequest();
      if (!description) return;
      setTemplateDescription(description);
      handleOpenTemplateGenerator();
      void handleGenerateWorkflowTemplate(description);
    };
    receive();
    window.addEventListener(WORKFLOW_TEMPLATE_REQUEST_EVENT, receive);
    return () => window.removeEventListener(WORKFLOW_TEMPLATE_REQUEST_EVENT, receive);
  }, [open, standalone, handleOpenTemplateGenerator, handleGenerateWorkflowTemplate]);

  const updateTemplateDraftNode = useCallback((index: number, patch: Partial<WorkflowTemplateDraft['nodes'][number]>) => {
    setTemplateDraft((draft) => draft ? {
      ...draft,
      nodes: draft.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node),
    } : null);
    setTemplateError('');
  }, []);

  const updateTemplateDraftEdge = useCallback((index: number, patch: Partial<WorkflowTemplateDraft['edges'][number]>) => {
    setTemplateDraft((draft) => draft ? {
      ...draft,
      edges: draft.edges.map((edge, edgeIndex) => edgeIndex === index ? { ...edge, ...patch } : edge),
    } : null);
    setTemplateError('');
  }, []);

  const handleAddTemplateDraftEdge = useCallback(() => {
    setTemplateDraft((draft) => {
      if (!draft || draft.nodes.length < 2) return draft;
      for (const from of draft.nodes) {
        for (const to of draft.nodes) {
          if (from.id === to.id) continue;
          if (!draft.edges.some((edge) => edge.from === from.id && edge.to === to.id)) {
            return { ...draft, edges: [...draft.edges, { from: from.id, to: to.id }] };
          }
        }
      }
      return draft;
    });
    setTemplateError('');
  }, []);

  const handleConfirmWorkflowTemplate = useCallback(() => {
    if (!templateDraft) return;
    const validation = validateWorkflowTemplateDraft(templateDraft, {
      allowedAgentIds: workflowTemplateAgents.map((agent) => agent.id),
    });
    if (validation.ok === false) {
      setTemplateError(validation.error);
      return;
    }
    const applied = applyTemplateDraftToCanvas({
      draft: validation.draft,
      mode: templateApplyMode,
      existingNodes: customWorkflowNodes,
      existingEdges: customWorkflowEdges,
    });
    setCustomWorkflowNodes(applied.nodes);
    setCustomWorkflowEdges(applied.edges);
    if (templateApplyMode === 'replace') {
      const replacedNodeIds = new Set(customWorkflowNodes.map((node) => node.id));
      setWorkflowNodeLayout((layout) => Object.fromEntries(
        Object.entries(layout).filter(([nodeId]) => !replacedNodeIds.has(nodeId)),
      ));
    }
    setSelectedNodeId(applied.firstNodeId);
    setConnectFromNodeId('');
    setRestoredWorkflowDraft(false);
    handleCloseTemplateGenerator();
    setTemplateError('');
    addToast(`已${templateApplyMode === 'merge' ? '加入' : '应用'}模板：${validation.draft.title}`, 'success', 2200);
  }, [
    addToast,
    customWorkflowEdges,
    customWorkflowNodes,
    handleCloseTemplateGenerator,
    templateApplyMode,
    templateDraft,
    workflowTemplateAgents,
  ]);

  const handleBindExecutionChannel = useCallback(async () => {
    if (!channelsEnabled) {
      setExecutionError('请先启用频道功能，再关联执行频道。');
      return;
    }
    if (!executionChannelId && !executionChannelName.trim()) {
      setExecutionError('请选择现有频道，或填写新频道名称。');
      return;
    }
    if (!executionChannelId && executionMembers.length < 2) {
      setExecutionError('频道至少需要选择两个 Agent。');
      return;
    }
    setExecutionSetupBusy(true);
    setExecutionError('');
    try {
      if (executionChannelId) {
        await openChannel(executionChannelId, false);
      } else {
        const createdId = await createChannel(executionChannelName.trim(), executionMembers);
        if (!createdId) throw new Error('频道创建失败，请检查频道服务后重试。');
        setExecutionChannelId(createdId);
        localStorage.setItem(executionBindingKey, createdId);
      }
      if (executionChannelId) localStorage.setItem(executionBindingKey, executionChannelId);
      setExecutionSetupOpen(false);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : String(error));
    } finally {
      setExecutionSetupBusy(false);
    }
  }, [channelsEnabled, executionBindingKey, executionChannelId, executionChannelName, executionMembers]);

  const addWorkflowResourceNode = useCallback((detail: WorkflowResourceEventDetail) => {
    if (!workflowScopeKey) {
      addToast('\u8bf7\u5148\u8fdb\u5165\u9891\u9053\u540e\u518d\u52a0\u5165\u5de5\u4f5c\u6d41\u8d44\u6e90', 'error');
      return;
    }
    if (detail.channelId && detail.channelId !== workflowChannelId) return;
    const stored = parseStoredWorkflow(window.localStorage?.getItem(workflowScopeKey) || null);
    const sourceNodes = open ? customWorkflowNodes : stored.nodes;
    const sourceEdges = open ? customWorkflowEdges : stored.edges;
    const index = sourceNodes.length + 1;
    const nodeId = `resource-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = String(detail.name || detail.path || detail.fileId || `\u8d44\u6e90 ${index}`);
    const ref = String(detail.path || detail.fileId || '');
    const node: CustomWorkflowNode = {
      id: nodeId,
      title: `\u8d44\u6e90\u4efb\u52a1 ${index}`,
      prompt: [
        `\u4f7f\u7528\u4f1a\u8bdd\u8d44\u6e90\uff1a${name}`,
        detail.kind ? `\u7c7b\u578b\uff1a${detail.kind}` : '',
        detail.mime ? `MIME\uff1a${detail.mime}` : '',
        ref ? `\u4f4d\u7f6e\uff1a${ref}` : '',
      ].filter(Boolean).join('\n'),
      agentId: (workflowChannelMembers.length ? workflowChannelMembers : agents.map(agent => agent.id))[(index - 1) % Math.max(1, workflowChannelMembers.length || agents.length)] || '',
      x: 312 + ((index - 1) % 2) * 254,
      y: 248 + Math.floor((index - 1) / 2) * 112,
    };
    const nextNodes = [...sourceNodes, node];
    setCustomWorkflowNodes(nextNodes);
    setCustomWorkflowEdges(sourceEdges);
    setSelectedNodeId(nodeId);
    setConnectFromNodeId('');
    setRestoredWorkflowDraft(false);
    persistStoredWorkflow(workflowScopeKey, {
      nodes: nextNodes,
      edges: sourceEdges,
      snapshots: workflowRunSnapshots,
      layout: workflowNodeLayout,
      hiddenTimelineItemIds,
    });
    addToast(`\u5df2\u52a0\u5165\u5de5\u4f5c\u6d41\uff1a${name}`, 'success', 1800);
  }, [addToast, agents, customWorkflowEdges, customWorkflowNodes, hiddenTimelineItemIds, open, workflowChannelId, workflowChannelMembers, workflowNodeLayout, workflowRunSnapshots, workflowScopeKey]);

  useEffect(() => {
    const handleResource = (event: Event) => {
      addWorkflowResourceNode((event as CustomEvent<WorkflowResourceEventDetail>).detail || {});
    };
    window.addEventListener('codia-channel-workflow-add-resource', handleResource);
    return () => window.removeEventListener('codia-channel-workflow-add-resource', handleResource);
  }, [addWorkflowResourceNode]);

  useEffect(() => {
    const action = pendingChannelResourceAction;
    if (!open || !workflowChannelId || !action) return;
    if (action.target !== 'workflow' || action.channelId !== workflowChannelId) return;
    consumePendingChannelResourceAction(action.id);
    addWorkflowResourceNode({
      channelId: action.channelId,
      fileId: action.file.fileId,
      name: action.file.name,
      path: action.file.path,
      kind: action.file.resource?.kind,
      mime: action.file.mimeType || action.file.resource?.mime,
    });
  }, [addWorkflowResourceNode, consumePendingChannelResourceAction, open, pendingChannelResourceAction, workflowChannelId]);

  const handleDeleteWorkflow = useCallback(() => {
    setCustomWorkflowNodes([]);
    setCustomWorkflowEdges([]);
    setWorkflowRunSnapshots([]);
    setWorkflowNodeLayout({});
    setHiddenTimelineItemIds([]);
    setSelectedNodeId('');
    setConnectFromNodeId('');
    setWorkflowInteraction(null);
    setRestoredWorkflowDraft(false);
    if (workflowScopeKey) persistStoredWorkflow(workflowScopeKey, { nodes: [], edges: [], snapshots: [], hiddenTimelineItemIds: [] });
  }, [setWorkflowInteraction, workflowScopeKey]);

  const handleDeleteSelectedNode = useCallback(() => {
    if (!selectedCustomNode) return;
    setCustomWorkflowNodes((nodes) => nodes.filter((node) => node.id !== selectedCustomNode.id));
    setCustomWorkflowEdges((edges) => edges.filter((edge) => (
      edge.from !== selectedCustomNode.id && edge.to !== selectedCustomNode.id
    )));
    setWorkflowNodeLayout((layout) => {
      const { [selectedCustomNode.id]: _removed, ...next } = layout;
      return next;
    });
    setSelectedNodeId('');
    setConnectFromNodeId('');
  }, [selectedCustomNode]);

  const handleStartConnect = useCallback(() => {
    if (!selectedNodeId) {
      addToast('请先选择一个节点作为连线起点', 'info', 2200);
      return;
    }
    setConnectFromNodeId(selectedNodeId);
  }, [addToast, selectedNodeId]);

  const addWorkflowEdge = useCallback((fromNodeId: string, toNodeId: string) => {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
    const id = `custom-edge-${fromNodeId}-${toNodeId}`;
    setCustomWorkflowEdges((edges) => {
      if (edges.some((edge) => edge.from === fromNodeId && edge.to === toNodeId)) return edges;
      return [...edges, { id, from: fromNodeId, to: toNodeId }];
    });
  }, []);

  const handleWorkflowNodeClick = useCallback((node: WorkflowNode) => {
    if (suppressNodeClickRef.current) {
      suppressNodeClickRef.current = false;
      return;
    }
    if (connectFromNodeId) {
      addWorkflowEdge(connectFromNodeId, node.id);
      setConnectFromNodeId('');
      setSelectedNodeId(node.id);
      return;
    }
    setSelectedNodeId(node.id);
    if (node.taskId) {
      window.dispatchEvent(new CustomEvent('codia-channel-workflow-focus-task', {
        detail: { taskId: node.taskId, nodeId: node.id, channelId: workflowChannelId },
      }));
    }
  }, [addWorkflowEdge, connectFromNodeId, workflowChannelId]);

  const snapshotWorkflowRun = useCallback((status: WorkflowRunSnapshot['status'], failure?: string): WorkflowRunSnapshot => {
    const now = new Date().toISOString();
    const latestMessage = channelMessages[channelMessages.length - 1];
    const failedNodeIds = new Set(
      workflowRunSnapshots.flatMap((snapshot) =>
        snapshot.nodes.filter((node) => node.retryState === 'failed').map((node) => node.nodeId)),
    );
    const taskById = new Map(scopedCompanyTasks.map((task) => [task.id, task]));
    const customById = new Map(customWorkflowNodes.map((node) => [node.id, node]));
    const resolveAgentName = (agentId?: string) => agentId
      ? resolveChannelMember(agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap).displayName
      : undefined;
    const nodes = latestWorkflowNodesRef.current.filter(node => customWorkflowNodes.length ? customById.has(node.id) : Boolean(node.taskId && !['completed', 'failed', 'cancelled'].includes(taskById.get(node.taskId)?.status || ''))).map((node): WorkflowRunNodeSnapshot => {
      const task = node.taskId ? taskById.get(node.taskId) : undefined;
      const custom = customById.get(node.id);
      const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria.filter(Boolean).join('；') : '';
      const isFailure = status === 'failed';
      const retryState: WorkflowRetryState = status === 'running'
        ? failedNodeIds.has(node.id) ? 'retrying' : 'running'
        : status === 'succeeded' ? 'succeeded' : 'failed';
      const agentName = resolveAgentName(node.agentId);
      return {
        nodeId: node.id,
        ...(node.taskId ? { taskId: node.taskId } : {}),
        label: node.title,
        ...(node.agentId ? { agentId: node.agentId } : {}),
        ...(agentName ? { agentName } : {}),
        input: detailText(custom?.prompt || task?.description || task?.title || latestMessage?.body || node.subtitle),
        output: detailText(criteria || node.meta || node.subtitle, status === 'running' ? '等待输出' : '已触发'),
        ...(isFailure ? { failure: failure || '工作流执行失败' } : {}),
        state: isFailure ? 'error' : status === 'succeeded' && node.state === 'idle' ? 'done' : node.state,
        retryState,
        triggeredAt: now,
      };
    });
    return {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: now,
      ...(status === 'running' ? {} : { finishedAt: now }),
      status,
      ...(failure ? { failure } : {}),
      nodes,
    };
  }, [
    agentMap,
    agents,
    channelMessages,
    currentAgentId,
    customWorkflowNodes,
    scopedCompanyTasks,
    userAvatarUrl,
    userName,
    workflowRunSnapshots,
  ]);

  const upsertWorkflowRunSnapshot = useCallback((snapshot: WorkflowRunSnapshot) => {
    if (currentWorkflowScopeRef.current !== workflowScopeKey) return;
    setWorkflowRunSnapshots((snapshots) => [
      snapshot,
      ...snapshots.filter((item) => item.id !== snapshot.id),
    ].slice(0, 20));
  }, [workflowScopeKey]);

  const handleExecuteWorkflow = useCallback(async (failedOnly = false, replayNodeId?: string) => {
    if (dispatchRunRef.current || activeWorkflowRun || !hasDispatchableWorkflow) return;
    if (standalone && (!workflowChannelId || !channelsEnabled)) {
      setExecutionSetupOpen(true);
      setExecutionError('');
      return;
    }
    if (!workflowChannelId) return;
    const failedIds = new Set(workflowRunSnapshots[0]?.nodes.filter(node => node.retryState === 'failed').map(node => node.nodeId));
    const selectedIds = replayNodeId ? new Set([replayNodeId]) : failedOnly ? failedIds : null;
    const priorOutputs = workflowRunSnapshots[0]?.nodes.filter(node => node.retryState === 'succeeded').map(node => `${node.label}: ${node.output}`).join('\n') || '';
    const plan = selectedIds ? { ...workflowPlan, nodes: workflowPlan.nodes.filter(node => selectedIds.has(node.id)).map(node => ({ ...node, prompt: priorOutputs ? `${node.prompt}\n\n已完成步骤结果：\n${priorOutputs}` : node.prompt })), edges: workflowPlan.edges.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to)) } : workflowPlan;
    if (failedOnly && !plan.nodes.length) return;
    const initial = snapshotWorkflowRun('running');
    const runningSnapshot: WorkflowRunSnapshot = { ...initial, status: 'queued', nodes: initial.nodes.filter(node => !selectedIds || selectedIds.has(node.nodeId)).map(node => ({ ...node, retryState: 'queued', state: 'idle', output: '等待任务结果' })) };
    dispatchRunRef.current = runningSnapshot.id;
    upsertWorkflowRunSnapshot(runningSnapshot);
    setTriggering(true);
    try {
      if (plan.nodes.length > 0) {
        const assignRes = await codiaFetch('/api/plugins/company/tasks/assign-from-workflow', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId: 'company_default', channelId: workflowChannelId, runId: runningSnapshot.id, ...(replayNodeId ? { source: 'workflow_replay' } : {}), workflow: plan }),
        });
        if (!assignRes.ok) throw new Error(`HTTP ${assignRes.status}`);
        const assigned = await assignRes.json();
        if (!cancelledRunIdsRef.current.has(runningSnapshot.id)) {
          upsertWorkflowRunSnapshot({ ...runningSnapshot, nodes: runningSnapshot.nodes.map(node => ({ ...node, taskId: assigned.tasks?.find((task: CompanyTask) => task.source?.nodeId === node.nodeId)?.id })) });
        }
        // Run-aware assignment performs dependency-gated dispatch itself.
      } else if (!cancelledRunIdsRef.current.has(runningSnapshot.id)) {
        const res = await codiaFetch(`/api/channels/${encodeURIComponent(workflowChannelId)}/trigger`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'workflow_window', workflowPlan: plan, mentionedAgents }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      await loadCompanyStatus();
    } catch (err) {
      if (!cancelledRunIdsRef.current.has(runningSnapshot.id)) {
        const message = err instanceof Error ? err.message : String(err);
        upsertWorkflowRunSnapshot({ ...runningSnapshot, status: 'awaiting_approval', failure: `派发结果未知，请检查后再决定：${message}`,
          nodes: runningSnapshot.nodes.map(node => ({ ...node, retryState: 'awaiting_approval', state: 'blocked', failure: message })) });
        addToast(`派发未确认，请先检查实际任务结果: ${message}`, 'error');
      }
    } finally {
      dispatchRunRef.current = null;
      setTriggering(false);
    }
  }, [activeWorkflowRun, addToast, workflowChannelId, standalone, channelsEnabled, hasDispatchableWorkflow, loadCompanyStatus, mentionedAgents, snapshotWorkflowRun, upsertWorkflowRunSnapshot, workflowPlan, workflowRunSnapshots]);

  const handleCancelWorkflow = useCallback(async () => {
    if (!activeWorkflowRun || cancellingRun) return;
    setCancellingRun(true);
    cancelledRunIdsRef.current.add(activeWorkflowRun.id);
    try {
      const res = await codiaFetch(`/api/plugins/company/workflow-runs/${encodeURIComponent(activeWorkflowRun.id)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: 'company_default', taskIds: activeWorkflowRun.nodes.flatMap(node => node.taskId ? [node.taskId] : []) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      upsertWorkflowRunSnapshot({ ...activeWorkflowRun, status: 'cancelled', finishedAt: new Date().toISOString(), nodes: activeWorkflowRun.nodes.map(node => node.retryState === 'succeeded' || node.retryState === 'failed' ? node : { ...node, retryState: 'cancelled', state: 'blocked' }) });
      addToast('已停止后续派发；已经开始的操作可能仍会完成', 'info');
    } catch (err) {
      cancelledRunIdsRef.current.delete(activeWorkflowRun.id);
      addToast(`取消未确认: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally { setCancellingRun(false); }
  }, [activeWorkflowRun, cancellingRun, addToast, upsertWorkflowRunSnapshot]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (templateDialogOpen) {
        handleCloseTemplateGenerator();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCloseTemplateGenerator, onClose, open, templateDialogOpen]);

  const graph = useMemo(() => {
    if ((!workflowChannelId && !standalone) || (!workflowChannelId && customWorkflowNodes.length === 0 && customWorkflowEdges.length === 0)) {
      return {
        nodes: [] as WorkflowNode[],
        edges: [] as WorkflowEdge[],
        stages: [] as WorkflowStage[],
        width: WORKFLOW_CANVAS_BASE_W,
        height: WORKFLOW_CANVAS_BASE_H,
        taskCount: 0,
        activeCount: 0,
        errorCount: 0,
        isEmpty: true,
      };
    }
    const ticker = workflowChannelId ? tickerStatuses?.[workflowChannelId] || null : null;
    const activitiesByAgent = workflowChannelId ? allActivities?.[workflowChannelId] || {} : {};
    const tasks = scopedCompanyTasks;
    if (companyStatus !== null && tasks.length === 0 && customWorkflowNodes.length === 0) {
      return {
        nodes: [] as WorkflowNode[],
        edges: [] as WorkflowEdge[],
        stages: [
          { key: 'input', label: '输入', value: '0 条消息', state: 'idle' },
          { key: 'schedule', label: '调度', value: '未触发', state: 'idle' },
          { key: 'agent', label: 'Agent 执行', value: '0 个成员', state: 'idle' },
          { key: 'task', label: '任务 / 回报', value: '0 个任务', state: 'idle' },
        ] as WorkflowStage[],
        width: WORKFLOW_CANVAS_BASE_W,
        height: WORKFLOW_CANVAS_BASE_H,
        taskCount: 0,
        activeCount: 0,
        errorCount: 0,
        isEmpty: true,
      };
    }
    const hasPersistedTasks = tasks.length > 0;
    const hasCustomNodes = customWorkflowNodes.length > 0;
    const hasWorkflowWork = !companyStatus || hasPersistedTasks || hasCustomNodes;

    const schedulerState: WorkflowNode['state'] =
      hasWorkflowWork && (ticker?.running || ticker?.active) ? 'running' : hasWorkflowWork && ticker?.queued ? 'blocked' : 'idle';
    const nodes: WorkflowNode[] = [];
    if (workflowChannelId) nodes.push(...[
      {
        id: 'channel-input',
        kind: 'input',
        title: '频道输入',
        subtitle: workflowChannelName || '独立工作流草稿',
        meta: `${channelMessages.length} 条消息`,
        state: channelMessages.length > 0 ? 'done' : 'idle',
        x: 36,
        y: 104,
        w: NODE_W,
        h: NODE_H,
      }, {
        id: 'scheduler',
        kind: 'scheduler',
        title: '调度器',
        subtitle: ticker?.running ? '正在轮询 Agent' : ticker?.queued ? '等待上一轮完成' : '等待触发',
        meta: ticker?.active?.agentCount ? `${ticker.active.delivered ?? 0}/${ticker.active.agentCount} 已触达` : '频道调度',
        state: schedulerState,
        x: 310,
        y: 104,
        w: NODE_W,
        h: NODE_H,
      },
    ] as WorkflowNode[]);
    const edges: WorkflowEdge[] = workflowChannelId ? [{ id: 'channel-input:scheduler', from: 'channel-input', to: 'scheduler', state: 'done' }] : [];

    customWorkflowNodes.forEach((node, index) => {
      nodes.push({
        id: node.id,
        kind: 'task',
        title: node.title,
        subtitle: node.prompt || '等待填写执行目标',
        meta: node.agentId ? `指挥 ${node.agentId}` : '工作流节点',
        state: 'idle',
        x: node.x || (312 + (index % 2) * 254),
        y: node.y || (248 + Math.floor(index / 2) * 112),
        w: TASK_NODE_W,
        h: TASK_NODE_H,
        agentId: node.agentId || undefined,
        custom: true,
      });
    });

    const relevantMemberIds = new Set<string>();
    for (const task of tasks) {
      if (task.assigneeAgentId) relevantMemberIds.add(task.assigneeAgentId);
    }
    for (const node of customWorkflowNodes) {
      if (node.agentId) relevantMemberIds.add(node.agentId);
    }
    for (const [agentId, history] of Object.entries(activitiesByAgent)) {
      const latest = Array.isArray(history) ? history[0] : null;
      if (!latest || activityState(latest) === 'idle') continue;
      if (hasPersistedTasks || relevantMemberIds.has(agentId)) {
        relevantMemberIds.add(agentId);
      }
    }
    for (const agentId of workflowPlan.supervision.supervisorAgentIds) {
      if (hasPersistedTasks || hasCustomNodes) relevantMemberIds.add(agentId);
    }
    const members = hasWorkflowWork
      ? workflowChannelMembers.filter((agentId) => relevantMemberIds.has(agentId))
      : [];
    members.forEach((agentId, index) => {
      const history = activitiesByAgent[agentId] || [];
      const latest = history[0];
      const nodeState = activityState(latest);
      const agentInfo = resolveChannelMember(agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap);
      const role = workflowChannelMemberRoles[agentId];
      const y = 36 + index * 132;
      nodes.push({
        id: `agent:${agentId}`,
        kind: 'agent',
        title: agentInfo.displayName,
        subtitle: latestActivitySummary(latest),
        meta: role === 'project_manager'
          ? '总监监督'
          : role === 'admin'
            ? '流程监督'
            : activitySessionPath(latest) ? '已连接执行会话' : 'Agent Phone',
        state: nodeState,
        x: 594,
        y,
        w: NODE_W,
        h: AGENT_NODE_H,
        agentId,
      });
      nodes.push({
        id: `output:${agentId}`,
        kind: 'output',
        title: '频道回报',
        subtitle: latest?.state === 'no_reply' ? '本轮不发言' : latest?.state === 'idle' ? '已回写频道' : '等待回报',
        meta: latest?.timestamp ? formatChannelTime(latest.timestamp) : '',
        state: nodeState === 'running' ? 'idle' : nodeState,
        x: 875,
        y,
        w: NODE_W,
        h: AGENT_NODE_H,
        agentId,
      });
      edges.push({ id: `scheduler:agent:${agentId}`, from: 'scheduler', to: `agent:${agentId}`, state: nodeState });
      edges.push({ id: `agent:${agentId}:output`, from: `agent:${agentId}`, to: `output:${agentId}`, state: nodeState });
    });

    const taskStartY = Math.max(390, 36 + members.length * 132 + 36);
    tasks.slice(0, 12).forEach((task, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const assignee = task.assigneeAgentId || '';
      const taskId = `task:${task.id}`;
      const state = taskState(task.status);
      nodes.push({
        id: taskId,
        kind: 'task',
        title: task.title || task.description || task.id,
        subtitle: statusText(task.status),
        meta: task.treeId ? `树 ${task.treeId}` : '',
        state,
        x: 312 + col * 254,
        y: taskStartY + row * 112,
        w: TASK_NODE_W,
        h: TASK_NODE_H,
        agentId: assignee || undefined,
        taskId: task.id,
      });
      if (assignee && members.includes(assignee)) {
        edges.push({ id: `agent:${assignee}:${taskId}`, from: `agent:${assignee}`, to: taskId, state });
      } else {
        edges.push({ id: `scheduler:${taskId}`, from: 'scheduler', to: taskId, state });
      }
    });

    const customIncoming = new Set(customWorkflowEdges.map((edge) => edge.to));
    customWorkflowNodes.forEach((node) => {
      if (!customIncoming.has(node.id)) {
        edges.push({ id: `scheduler:${node.id}`, from: 'scheduler', to: node.id, state: 'idle' });
      }
    });
    const graphNodeIds = new Set(nodes.map((node) => node.id));
    customWorkflowEdges.forEach((edge) => {
      if (!graphNodeIds.has(edge.from) || !graphNodeIds.has(edge.to)) return;
      edges.push({ id: edge.id, from: edge.from, to: edge.to, state: 'idle' });
    });

    const latestRun = workflowRunSnapshots[0];
    for (const node of nodes) {
      const evidence = latestRun?.nodes.find(step => step.nodeId === node.id);
      if (evidence) { node.state = evidence.state; node.meta = evidence.failure || evidence.output; }
    }
    for (const edge of edges) {
      const evidence = latestRun?.nodes.find(step => step.nodeId === edge.to);
      if (evidence) edge.state = evidence.state;
    }
    const agentStates = nodes.filter((node) => node.kind === 'agent').map((node) => node.state);
    const taskStates = nodes.filter((node) => node.kind === 'task').map((node) => node.state);
    const outputStates = nodes.filter((node) => node.kind === 'output').map((node) => node.state);
    const activeCount = nodes.filter((node) => node.state === 'running' || node.state === 'blocked').length;
    const errorCount = nodes.filter((node) => node.state === 'error').length;
    const completedTasks = tasks.filter((task) => task.status === 'completed').length;
    const stages: WorkflowStage[] = [
      {
        key: 'input',
        label: '输入',
        value: `${channelMessages.length} 条消息`,
        state: channelMessages.length > 0 ? 'done' : 'idle',
      },
      {
        key: 'schedule',
        label: '调度',
        value: ticker?.active?.agentCount ? `${ticker.active.delivered ?? 0}/${ticker.active.agentCount}` : ticker?.queued ? '排队中' : '待触发',
        state: schedulerState,
      },
      {
        key: 'agent',
        label: 'Agent 执行',
        value: `${members.length} 个成员`,
        state: dominantState(agentStates),
      },
      {
        key: 'task',
        label: '任务 / 回报',
        value: tasks.length > 0 ? `${completedTasks}/${tasks.length} 完成` : customWorkflowNodes.length > 0 ? `${customWorkflowNodes.length} 个草稿节点` : '0 个任务',
        state: tasks.length > 0 || customWorkflowNodes.length > 0 ? dominantState([...taskStates, ...outputStates]) : 'idle',
      },
    ];

    const positionedNodes = nodes.map((node) => {
      const position = workflowNodeLayout[node.id];
      if (!position) return node;
      return {
        ...node,
        x: Math.max(12, Math.round(position.x)),
        y: Math.max(12, Math.round(position.y)),
      };
    });
    const maxX = positionedNodes.reduce((value, node) => Math.max(value, node.x + node.w), 0);
    const maxY = positionedNodes.reduce((value, node) => Math.max(value, node.y + node.h), 0);
    return {
      nodes: positionedNodes,
      edges,
      stages,
      width: Math.max(WORKFLOW_CANVAS_BASE_W, maxX + WORKFLOW_CANVAS_EXPAND_MARGIN),
      height: Math.max(WORKFLOW_CANVAS_BASE_H, maxY + WORKFLOW_CANVAS_EXPAND_MARGIN),
      taskCount: tasks.length + customWorkflowNodes.length,
      activeCount,
      errorCount,
      isEmpty: false,
    };
  }, [
    agentMap,
    agents,
    allActivities,
    workflowChannelName,
    workflowChannelMemberRoles,
    workflowChannelMembers,
    channelMessages.length,
    companyStatus,
    currentAgentId,
    standalone,
    workflowChannelId,
    customWorkflowEdges,
    customWorkflowNodes,
    scopedCompanyTasks,
    workflowRunSnapshots,
    tickerStatuses,
    userAvatarUrl,
    workflowNodeLayout,
    workflowPlan.supervision.supervisorAgentIds,
    userName,
  ]);

  useEffect(() => {
    latestWorkflowNodesRef.current = graph.nodes;
  }, [graph.nodes]);

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const directorSupervisors = useMemo(() => (
    workflowPlan.supervision.supervisorAgentIds.map((agentId) => ({
      id: agentId,
      info: resolveChannelMember(agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap),
      nodeId: `agent:${agentId}`,
    }))
  ), [agentMap, agents, currentAgentId, userAvatarUrl, userName, workflowPlan.supervision.supervisorAgentIds]);

  const directorBlockedTasks = useMemo(
    () => scopedCompanyTasks.filter(isBlockedTask),
    [scopedCompanyTasks],
  );

  const directorReviewTasks = useMemo(
    () => scopedCompanyTasks.filter(isReviewTask),
    [scopedCompanyTasks],
  );

  const scrollWorkflowNodeIntoView = useCallback((nodeId: string) => {
    const node = nodeById.get(nodeId);
    const scroller = canvasScrollRef.current;
    if (!node || !scroller) return;
    window.requestAnimationFrame(() => {
      scroller.scrollTo({
        left: Math.max(0, (node.x + node.w / 2) * zoom - scroller.clientWidth / 2),
        top: Math.max(0, (node.y + node.h / 2) * zoom - scroller.clientHeight / 2),
        behavior: 'smooth',
      });
    });
  }, [nodeById, zoom]);

  const applyWorkflowNodePosition = useCallback((nodeId: string, x: number, y: number, nodeW: number, nodeH: number) => {
    void nodeW;
    void nodeH;
    const next = {
      x: Math.max(12, Math.round(x)),
      y: Math.max(12, Math.round(y)),
    };
    if (customNodeIdsRef.current.has(nodeId)) {
      setCustomWorkflowNodes((nodes) => nodes.map((node) => (
        node.id === nodeId ? { ...node, x: next.x, y: next.y } : node
      )));
      return;
    }
    setWorkflowNodeLayout((layout) => ({
      ...layout,
      [nodeId]: next,
    }));
  }, []);

  const getWorkflowCanvasPoint = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / zoom,
      y: (event.clientY - rect.top) / zoom,
    };
  }, [zoom]);

  const handleWorkflowCanvasWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const scroller = canvasScrollRef.current;
    if (!scroller || event.deltaY === 0) return;
    event.preventDefault();
    const rect = scroller.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    setZoom((currentZoom) => {
      const direction = event.deltaY > 0 ? -1 : 1;
      const nextZoom = clamp(
        Math.round((currentZoom + direction * WORKFLOW_ZOOM_STEP) * 100) / 100,
        WORKFLOW_ZOOM_MIN,
        WORKFLOW_ZOOM_MAX,
      );
      if (nextZoom === currentZoom) return currentZoom;

      const canvasX = (scroller.scrollLeft + pointerX) / currentZoom;
      const canvasY = (scroller.scrollTop + pointerY) / currentZoom;
      const updateScroll = () => {
        scroller.scrollLeft = Math.max(0, canvasX * nextZoom - pointerX);
        scroller.scrollTop = Math.max(0, canvasY * nextZoom - pointerY);
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(updateScroll);
      } else {
        updateScroll();
      }
      return nextZoom;
    });
  }, []);

  const handleWorkflowCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || workflowInteractionRef.current) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-workflow-node-id], [data-workflow-port], button, input, textarea, select, a')) return;
    const scroller = canvasScrollRef.current;
    if (!scroller) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setWorkflowInteraction({
      type: 'canvas',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originScrollLeft: scroller.scrollLeft,
      originScrollTop: scroller.scrollTop,
      moved: false,
    });
  }, [setWorkflowInteraction]);

  const findWorkflowNodeIdAtPoint = useCallback((event: PointerEvent) => {
    const elements = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(event.clientX, event.clientY)
      : [];
    const elementAtPoint = elements.find((element) => element instanceof HTMLElement && element.hasAttribute('data-workflow-node-id'));
    const fallback = event.target instanceof Element
      ? event.target.closest('[data-workflow-node-id]')
      : null;
    const nodeElement = (elementAtPoint || fallback) as HTMLElement | null;
    return nodeElement?.dataset.workflowNodeId || '';
  }, []);

  const handleWorkflowNodePointerDown = useCallback((node: WorkflowNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || connectFromNodeId) return;
    event.preventDefault();
    setSelectedNodeId(node.id);
    setWorkflowInteraction({
      type: 'node',
      pointerId: event.pointerId,
      nodeId: node.id,
      originX: node.x,
      originY: node.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      nodeW: node.w,
      nodeH: node.h,
      moved: false,
    });
  }, [connectFromNodeId, setWorkflowInteraction]);

  const handleWorkflowPortConnectDrag = useCallback((node: WorkflowNode, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getWorkflowCanvasPoint(event) || { x: node.x + node.w, y: node.y + node.h / 2 };
    setSelectedNodeId(node.id);
    setConnectFromNodeId(node.id);
    setWorkflowInteraction({
      type: 'edge',
      pointerId: event.pointerId,
      fromNodeId: node.id,
      startX: node.x + node.w,
      startY: node.y + node.h / 2,
      currentX: point.x,
      currentY: point.y,
    });
  }, [getWorkflowCanvasPoint, setWorkflowInteraction]);

  const handleWorkflowPointerMove = useCallback((event: PointerEvent) => {
    const active = workflowInteractionRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    if (active.type === 'canvas') {
      const scroller = canvasScrollRef.current;
      if (!scroller) return;
      const dx = event.clientX - active.startClientX;
      const dy = event.clientY - active.startClientY;
      const moved = active.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2;
      scroller.scrollLeft = Math.max(0, active.originScrollLeft - dx);
      scroller.scrollTop = Math.max(0, active.originScrollTop - dy);
      if (moved !== active.moved) setWorkflowInteraction({ ...active, moved });
      return;
    }
    if (active.type === 'node') {
      const dx = (event.clientX - active.startClientX) / zoom;
      const dy = (event.clientY - active.startClientY) / zoom;
      const moved = active.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2;
      const nextInteraction = { ...active, moved };
      if (moved) suppressNodeClickRef.current = true;
      setWorkflowInteraction(nextInteraction);
      applyWorkflowNodePosition(active.nodeId, active.originX + dx, active.originY + dy, active.nodeW, active.nodeH);
      return;
    }
    const point = getWorkflowCanvasPoint(event);
    if (!point) return;
    setWorkflowInteraction({
      ...active,
      currentX: point.x,
      currentY: point.y,
    });
  }, [applyWorkflowNodePosition, getWorkflowCanvasPoint, setWorkflowInteraction, zoom]);

  const handleWorkflowPointerUp = useCallback((event: PointerEvent) => {
    const active = workflowInteractionRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    if (active.type === 'edge') {
      const targetNodeId = findWorkflowNodeIdAtPoint(event);
      addWorkflowEdge(active.fromNodeId, targetNodeId);
      setSelectedNodeId(targetNodeId || active.fromNodeId);
      setConnectFromNodeId('');
    }
    if (active.type === 'node' && active.moved) {
      suppressNodeClickRef.current = true;
    }
    setWorkflowInteraction(null);
  }, [addWorkflowEdge, findWorkflowNodeIdAtPoint, setWorkflowInteraction]);

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('pointermove', handleWorkflowPointerMove);
    window.addEventListener('pointerup', handleWorkflowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWorkflowPointerMove);
      window.removeEventListener('pointerup', handleWorkflowPointerUp);
    };
  }, [handleWorkflowPointerMove, handleWorkflowPointerUp, open]);

  const handleDirectorSupervisorClick = useCallback((nodeId: string) => {
    if (!nodeById.has(nodeId)) return;
    setSelectedNodeId(nodeId);
    scrollWorkflowNodeIntoView(nodeId);
  }, [nodeById, scrollWorkflowNodeIntoView]);

  useEffect(() => {
    if (!open) return undefined;
    const handleTaskFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; channelId?: string }>).detail || {};
      if (!detail.taskId) return;
      if (detail.channelId && detail.channelId !== workflowChannelId) return;
      const nodeId = `task:${detail.taskId}`;
      if (!nodeById.has(nodeId)) return;
      setSelectedNodeId(nodeId);
      scrollWorkflowNodeIntoView(nodeId);
    };
    window.addEventListener('codia-channel-task-focus-workflow', handleTaskFocus);
    return () => window.removeEventListener('codia-channel-task-focus-workflow', handleTaskFocus);
  }, [nodeById, open, scrollWorkflowNodeIntoView, workflowChannelId]);

  const timelineItems = useMemo<WorkflowTimelineItem[]>(() => {
    if (!workflowChannelId && workflowRunSnapshots.length === 0) return [];
    const items: WorkflowTimelineItem[] = [];
    const latestMessage = channelMessages[channelMessages.length - 1];
    const activitiesByAgent = workflowChannelId ? allActivities?.[workflowChannelId] || {} : {};
    const taskById = new Map(scopedCompanyTasks.map((task) => [task.id, task]));
    const customById = new Map(customWorkflowNodes.map((node) => [node.id, node]));
    const agentName = (agentId?: string) => agentId
      ? resolveChannelMember(agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap).displayName
      : undefined;
    const snapshotItems = workflowRunSnapshots.flatMap((snapshot) => (
      snapshot.nodes.map((node) => ({
        id: `${snapshot.id}:${node.nodeId}`,
        nodeId: node.nodeId,
        time: node.triggeredAt ? formatChannelTime(node.triggeredAt) : formatChannelTime(snapshot.startedAt),
        label: node.label,
        agentName: node.agentName,
        input: node.input,
        output: node.output,
        failure: node.failure || snapshot.failure,
        retryState: node.retryState,
        state: node.state,
      }))
    ));
    const activityItems = activityHubTimelineItems(channelWorkflowActivities);

    for (const node of graph.nodes) {
      if (node.kind === 'input') {
        items.push({
          id: `${node.id}:input`,
          nodeId: node.id,
          time: latestMessage?.timestamp ? formatChannelTime(latestMessage.timestamp) : '未触发',
          label: node.title,
          input: detailText(latestMessage?.body, '暂无频道输入'),
          output: detailText(node.meta, '等待调度'),
          state: node.state,
        });
        continue;
      }
      if (node.kind === 'scheduler') {
        items.push({
          id: `${node.id}:scheduler`,
          nodeId: node.id,
          time: latestMessage?.timestamp ? formatChannelTime(latestMessage.timestamp) : '未触发',
          label: node.title,
          input: detailText(latestMessage?.body, '等待频道输入'),
          output: detailText(node.subtitle),
          failure: node.state === 'blocked' ? '上一轮任务尚未完成' : undefined,
          state: node.state,
        });
        continue;
      }
      if (node.kind === 'agent' || node.kind === 'output') {
        const history = node.agentId ? activitiesByAgent[node.agentId] || [] : [];
        const latest = history[0];
        items.push({
          id: `${node.id}:${latest?.timestamp || 'pending'}`,
          nodeId: node.id,
          time: latest?.timestamp ? formatChannelTime(latest.timestamp) : '未触发',
          label: node.title,
          agentName: agentName(node.agentId),
          input: detailText(node.subtitle, '等待 Agent 接收任务'),
          output: detailText(latest?.summary || node.meta, '等待回报'),
          failure: latest?.state === 'error' ? detailText(latest.summary, 'Agent 执行失败') : undefined,
          state: node.state,
        });
        continue;
      }
      const task = node.taskId ? taskById.get(node.taskId) : undefined;
      const custom = customById.get(node.id);
      const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria.filter(Boolean).join('；') : '';
      items.push({
        id: `${node.id}:task`,
        nodeId: node.id,
        time: task?.updatedAt || task?.createdAt ? formatChannelTime(String(task.updatedAt || task.createdAt)) : '待触发',
        label: node.title,
        agentName: agentName(node.agentId),
        input: detailText(custom?.prompt || task?.description || task?.title || node.subtitle),
        output: detailText(criteria || node.meta, '等待输出'),
        failure: node.state === 'blocked' || node.state === 'error' ? statusText(task?.status) : undefined,
        state: node.state,
      });
    }

    const hiddenIds = new Set(hiddenTimelineItemIds);
    return [...snapshotItems, ...activityItems, ...items].filter((item) => !hiddenIds.has(item.id)).slice(0, 40);
  }, [
    agentMap,
    agents,
    allActivities,
    channelMessages,
    channelWorkflowActivities,
    currentAgentId,
    workflowChannelId,
    customWorkflowNodes,
    graph.isEmpty,
    graph.nodes,
    hiddenTimelineItemIds,
    scopedCompanyTasks,
    userAvatarUrl,
    userName,
    workflowRunSnapshots,
  ]);

  const handleDeleteTimelineItem = useCallback((itemId: string) => {
    setHiddenTimelineItemIds((ids) => uniqueStrings([...ids, itemId]).slice(0, 200));
    if (workflowReplayItemId === itemId) {
      setWorkflowReplayItemId('');
      setWorkflowReplayPlaying(false);
    }
  }, [workflowReplayItemId]);

  const handleClearTimeline = useCallback(() => {
    if (timelineItems.length === 0 && workflowRunSnapshots.length === 0) return;
    setWorkflowRunSnapshots([]);
    setHiddenTimelineItemIds((ids) => uniqueStrings([
      ...ids,
      ...timelineItems.map((item) => item.id),
    ]).slice(0, 200));
    setWorkflowReplayItemId('');
    setWorkflowReplayPlaying(false);
  }, [timelineItems, workflowRunSnapshots.length]);

  const focusWorkflowTimelineItem = useCallback((item: WorkflowTimelineItem) => {
    setWorkflowReplayItemId(item.id);
    setSelectedNodeId(item.nodeId);
    scrollWorkflowNodeIntoView(item.nodeId);
    if (item.nodeId.startsWith('task:')) {
      window.dispatchEvent(new CustomEvent('codia-channel-workflow-focus-task', {
        detail: { taskId: item.nodeId.slice(5), nodeId: item.nodeId, channelId: workflowChannelId },
      }));
    }
  }, [workflowChannelId, scrollWorkflowNodeIntoView]);

  const handleReplayTimelineItem = useCallback((item: WorkflowTimelineItem) => {
    focusWorkflowTimelineItem(item);
  }, [focusWorkflowTimelineItem]);

  const handleRerunWorkflowReplayItem = useCallback(async () => {
    if (activeWorkflowRun || workflowReplayRerunning) return;
    const item = timelineItems.find(entry => entry.id === workflowReplayItemId);
    if (!item || !customNodeIds.has(item.nodeId)) {
      addToast('只能重跑自定义任务节点', 'info', 2200);
      return;
    }
    setWorkflowReplayRerunning(true);
    try { await handleExecuteWorkflow(false, item.nodeId); }
    finally { setWorkflowReplayRerunning(false); }
  }, [activeWorkflowRun, workflowReplayRerunning, timelineItems, workflowReplayItemId, customNodeIds, addToast, handleExecuteWorkflow]);

  const stepWorkflowReplay = useCallback((direction: -1 | 1) => {
    if (timelineItems.length === 0) return;
    const currentIndex = timelineItems.findIndex((item) => item.id === workflowReplayItemId);
    const nextIndex = currentIndex < 0
      ? 0
      : clamp(currentIndex + direction, 0, timelineItems.length - 1);
    focusWorkflowTimelineItem(timelineItems[nextIndex]);
  }, [focusWorkflowTimelineItem, timelineItems, workflowReplayItemId]);

  useEffect(() => {
    if (!open || !workflowReplayPlaying) return undefined;
    if (timelineItems.length === 0) {
      setWorkflowReplayPlaying(false);
      return undefined;
    }
    const timer = window.setInterval(() => {
      const currentIndex = timelineItems.findIndex((item) => item.id === workflowReplayItemId);
      const nextIndex = currentIndex < 0 ? 0 : currentIndex + 1;
      if (nextIndex >= timelineItems.length) {
        setWorkflowReplayPlaying(false);
        return;
      }
      focusWorkflowTimelineItem(timelineItems[nextIndex]);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [focusWorkflowTimelineItem, open, timelineItems, workflowReplayItemId, workflowReplayPlaying]);

  const workflowReplayItem = useMemo(
    () => timelineItems.find((item) => item.id === workflowReplayItemId) || null,
    [timelineItems, workflowReplayItemId],
  );

  if (!open || (!workflowChannelId && !standalone)) return null;

  const canvasStageStyle = {
    width: graph.width * zoom,
    height: graph.height * zoom,
  };
  const canvasStyle = {
    width: graph.width,
    height: graph.height,
    transform: `scale(${zoom})`,
  };

  const workflowWindow = (
    <div
      className={`${styles.workflowWindowOverlay}${pageMode ? ` ${styles.workflowPageOverlay}` : ''}`}
      role={pageMode ? 'region' : 'dialog'}
      aria-modal={pageMode ? undefined : 'true'}
      aria-label={pageMode ? '工作流页面' : '工作流可视窗口'}
      data-workflow-activity-session-path={workflowActivitySessionPath || undefined}
      data-workflow-activity-count={channelWorkflowActivities.length}
    >
      <div className={styles.workflowWindowPanel}>
        <div className={styles.workflowWindowHeader}>
          <div>
            <div className={styles.workflowWindowKicker}>工作流画布</div>
            <div className={styles.workflowWindowTitle}>{workflowChannelName}</div>
          </div>
          <div className={styles.workflowWindowActions}>
            {companyError && <span className={styles.workflowWindowWarning}>任务树未连接</span>}
            <button ref={templateTriggerRef} type="button" className={`${styles.workflowWindowButton} ${styles.workflowWindowRunButton}`} onClick={handleOpenTemplateGenerator}>
              生成模板
            </button>
            <button type="button" className={styles.workflowWindowButton} onClick={handleAddWorkflowNode}>
              添加节点
            </button>
            <button
              type="button"
              className={`${styles.workflowWindowButton} ${connectFromNodeId ? styles.workflowConnectMode : ''}`}
              onClick={handleStartConnect}
            >
              {connectFromNodeId ? '选择终点' : '添加连线'}
            </button>
            <button
              type="button"
              className={`${styles.workflowWindowButton} ${styles.workflowWindowDangerButton}`}
              onClick={handleDeleteWorkflow}
              disabled={Boolean(activeWorkflowRun) || (customWorkflowNodes.length === 0 && customWorkflowEdges.length === 0)}
            >
              删除工作流
            </button>
            <button
              type="button"
              className={`${styles.workflowWindowButton} ${styles.workflowWindowRunButton}`}
              onClick={() => void handleExecuteWorkflow()}
              disabled={triggering || Boolean(activeWorkflowRun) || !hasDispatchableWorkflow || graph.isEmpty}
            >
              {activeWorkflowRun ? activeWorkflowRun.status === 'partial_failure' ? '部分失败，仍在执行' : activeWorkflowRun.status === 'awaiting_approval' ? '等待审批 / 解除阻塞' : activeWorkflowRun.status === 'queued' ? '已排队' : '执行中' : triggering ? '派发中' : '执行'}
            </button>
            {activeWorkflowRun && <button type="button" className={styles.workflowWindowButton} disabled={cancellingRun} onClick={() => void handleCancelWorkflow()}>{cancellingRun ? '取消中' : '取消后续执行'}</button>}
            {!activeWorkflowRun && workflowRunSnapshots[0]?.nodes.some(node => node.retryState === 'failed' && customNodeIds.has(node.nodeId)) && <button type="button" className={styles.workflowWindowButton} onClick={() => void handleExecuteWorkflow(true)}>仅重试失败步骤</button>}
            <button type="button" className={styles.workflowWindowButton} onClick={() => void loadCompanyStatus()}>
              刷新
            </button>
            <button type="button" className={styles.workflowWindowClose} aria-label="关闭" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
        {templateDialogOpen && <div className={styles.workflowSetupBackdrop}>
          <section
            ref={templateDialogRef}
            className={`${styles.workflowSetupCard} ${styles.workflowTemplateCard}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflowTemplateTitle"
            tabIndex={-1}
          >
            <div className={styles.workflowTemplateHeading}>
              <div>
                <h2 id="workflowTemplateTitle">生成工作流模板</h2>
                <p>描述目标后生成可编辑草稿，确认前不会修改当前画布。</p>
              </div>
              <button
                type="button"
                className={styles.workflowWindowClose}
                aria-label="关闭模板生成器"
                onClick={handleCloseTemplateGenerator}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <label className={styles.workflowSetupField}>
              <span>模板需求</span>
              <textarea
                rows={4}
                maxLength={4000}
                value={templateDescription}
                onChange={(event) => { setTemplateDescription(event.target.value); setTemplateError(''); }}
                placeholder="例如：先收集每周进展，再由项目经理汇总风险，最后生成周报并复核。"
              />
            </label>
            <div className={styles.workflowTemplateGenerateRow}>
              <span>{templateDescription.length}/4000</span>
              <button
                type="button"
                className={`${styles.workflowWindowButton} ${styles.workflowWindowRunButton}`}
                disabled={templateGenerating || !templateDescription.trim()}
                onClick={() => void handleGenerateWorkflowTemplate()}
              >
                {templateGenerating ? '生成中…' : templateDraft ? '重新生成' : '生成草稿'}
              </button>
            </div>
            {templateError && <div className={styles.workflowSetupError} role="alert">{templateError}</div>}
            {templateDraft && <div className={styles.workflowTemplatePreview} data-workflow-template-preview="true">
              <div className={styles.workflowTemplatePreviewHeader}>
                <label className={styles.workflowSetupField}>
                  <span>模板名称</span>
                  <input
                    value={templateDraft.title}
                    maxLength={120}
                    onChange={(event) => setTemplateDraft((draft) => draft ? { ...draft, title: event.target.value } : null)}
                  />
                </label>
                <label className={styles.workflowSetupField}>
                  <span>应用方式</span>
                  <select value={templateApplyMode} onChange={(event) => setTemplateApplyMode(event.target.value as 'merge' | 'replace')}>
                    <option value="merge">加入当前画布</option>
                    <option value="replace">替换当前自定义画布</option>
                  </select>
                </label>
              </div>
              <div className={styles.workflowTemplateSectionTitle}>节点预览（{templateDraft.nodes.length}）</div>
              <div className={styles.workflowTemplateNodeList}>
                {templateDraft.nodes.map((node, index) => <article key={node.id} className={styles.workflowTemplateNodeEditor}>
                  <div className={styles.workflowTemplateNodeIndex}>{index + 1}</div>
                  <label className={styles.workflowSetupField}>
                    <span>节点名称</span>
                    <input
                      value={node.title}
                      maxLength={120}
                      onChange={(event) => updateTemplateDraftNode(index, { title: event.target.value })}
                    />
                  </label>
                  <label className={styles.workflowSetupField}>
                    <span>执行目标</span>
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={node.prompt}
                      onChange={(event) => updateTemplateDraftNode(index, { prompt: event.target.value })}
                    />
                  </label>
                  <label className={styles.workflowSetupField}>
                    <span>指挥智能体</span>
                    <select value={node.agentId} onChange={(event) => updateTemplateDraftNode(index, { agentId: event.target.value })}>
                      <option value="">自动分配</option>
                      {workflowTemplateAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                  </label>
                </article>)}
              </div>
              <div className={styles.workflowTemplateSectionHeader}>
                <div className={styles.workflowTemplateSectionTitle}>连线预览（{templateDraft.edges.length}）</div>
                <button type="button" className={styles.workflowWindowButton} onClick={handleAddTemplateDraftEdge} disabled={templateDraft.nodes.length < 2 || templateDraft.edges.length >= 24}>添加连线</button>
              </div>
              <div className={styles.workflowTemplateEdgeList}>
                {templateDraft.edges.length === 0 && <div className={styles.workflowEditorHint}>当前模板没有节点连线。</div>}
                {templateDraft.edges.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`} className={styles.workflowTemplateEdgeEditor}>
                  <select aria-label={`第 ${index + 1} 条连线起点`} value={edge.from} onChange={(event) => updateTemplateDraftEdge(index, { from: event.target.value })}>
                    {templateDraft.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
                  </select>
                  <span>→</span>
                  <select aria-label={`第 ${index + 1} 条连线终点`} value={edge.to} onChange={(event) => updateTemplateDraftEdge(index, { to: event.target.value })}>
                    {templateDraft.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
                  </select>
                  <button
                    type="button"
                    className={styles.workflowTimelineDeleteButton}
                    aria-label={`删除第 ${index + 1} 条连线`}
                    onClick={() => setTemplateDraft((draft) => draft ? { ...draft, edges: draft.edges.filter((_, edgeIndex) => edgeIndex !== index) } : null)}
                  >
                    删除
                  </button>
                </div>)}
              </div>
            </div>}
            <div className={styles.workflowSetupActions}>
              <button type="button" className={styles.workflowWindowButton} onClick={handleCloseTemplateGenerator}>取消</button>
              <button
                type="button"
                className={`${styles.workflowWindowButton} ${styles.workflowWindowRunButton}`}
                disabled={!templateDraft || templateGenerating}
                onClick={handleConfirmWorkflowTemplate}
              >
                确认应用
              </button>
            </div>
          </section>
        </div>}
        {executionSetupOpen && <div className={styles.workflowSetupBackdrop}>
          <section className={styles.workflowSetupCard} role="dialog" aria-modal="true" aria-labelledby="workflowSetupTitle">
            <h2 id="workflowSetupTitle">关联执行频道</h2>
            {!channelsEnabled && <div className={styles.workflowSetupNotice}>
              频道功能当前已关闭。启用后才能关联频道和执行工作流。
              <button type="button" className={styles.workflowWindowButton} disabled={channelToggleBusy} onClick={async () => {
                setChannelToggleBusy(true);
                try {
                  const enabled = await toggleChannelsEnabled();
                  if (!enabled) setExecutionError('频道功能启用失败，请重试。');
                  else setExecutionError('');
                } finally { setChannelToggleBusy(false); }
              }}>{channelToggleBusy ? '正在启用…' : '启用频道功能'}</button>
            </div>}
            <label className={styles.workflowSetupField}>
              <span>选择现有频道</span>
              <select value={executionChannelId} onChange={event => { setExecutionChannelId(event.target.value); setExecutionError(''); }}>
                <option value="">新建频道…</option>
                {channels.filter(channel => !channel.isDM).map(channel => <option key={channel.id} value={channel.id}>{channel.name || channel.id}</option>)}
              </select>
            </label>
            {!executionChannelId && <>
              <label className={styles.workflowSetupField}>
                <span>新频道名称</span>
                <input value={executionChannelName} onChange={event => { setExecutionChannelName(event.target.value); setExecutionError(''); }} placeholder="例如：产品设计小队" />
              </label>
              <label className={styles.workflowSetupField}>
                <span>选择至少两个 Agent</span>
                <select multiple value={executionMembers} onChange={event => setExecutionMembers(Array.from(event.currentTarget.selectedOptions, option => option.value))}>
                  {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
                </select>
              </label>
            </>}
            {executionError && <div className={styles.workflowSetupError} role="alert">{executionError}</div>}
            <div className={styles.workflowSetupActions}>
              <button type="button" className={styles.workflowWindowButton} onClick={() => setExecutionSetupOpen(false)}>取消</button>
              <button type="button" className={styles.workflowWindowButton} disabled={executionSetupBusy || !channelsEnabled} onClick={() => void handleBindExecutionChannel()}>{executionSetupBusy ? '正在关联…' : '关联频道'}</button>
            </div>
          </section>
        </div>}
        <div className={styles.workflowWindowToolbar}>
          <div className={styles.workflowStageRail} aria-label="工作流执行阶段">
            {graph.stages.map((stage) => (
              <div key={stage.key} className={styles.workflowStage} data-state={stage.state}>
                <span>{stage.label}</span>
                <strong>{stage.value}</strong>
              </div>
            ))}
          </div>
          <div className={styles.workflowZoomControls} aria-label="缩放">
            {[0.75, 1, 1.25].map((value) => (
              <button
                key={value}
                type="button"
                className={zoom === value ? styles.workflowZoomActive : undefined}
                onClick={() => setZoom(value)}
              >
                {Math.round(value * 100)}%
              </button>
            ))}
          </div>
        </div>
        <div className={styles.workflowWindowMain}>
          <div
            className={styles.workflowWindowCanvasScroll}
            ref={canvasScrollRef}
            aria-label="工作流画布"
            data-workflow-canvas-scroll="true"
            data-workflow-panning={workflowInteraction?.type === 'canvas' ? 'true' : undefined}
            onWheel={handleWorkflowCanvasWheel}
            onPointerDown={handleWorkflowCanvasPointerDown}
          >
            <div className={styles.workflowCanvasStage} style={canvasStageStyle}>
              <div className={styles.workflowCanvas} style={canvasStyle} ref={canvasRef} data-workflow-canvas="true">
                {graph.isEmpty ? (
                  <div className={styles.workflowEmptyState}>
                    <strong>暂无工作流任务</strong>
                    <span>添加节点或从任务树派发后，画布会显示执行步骤。</span>
                  </div>
                ) : (
                  <>
                    <svg className={styles.workflowEdges} width={graph.width} height={graph.height} aria-hidden="true">
                      {graph.edges.map((edge) => {
                        const from = nodeById.get(edge.from);
                        const to = nodeById.get(edge.to);
                        if (!from || !to) return null;
                        return (
                          <path
                            key={edge.id}
                            d={edgePath(from, to)}
                            className={styles.workflowEdge}
                            data-state={edge.state}
                            data-workflow-edge-id={edge.id}
                            data-workflow-edge-from={edge.from}
                            data-workflow-edge-to={edge.to}
                          />
                        );
                      })}
                      {workflowInteraction?.type === 'edge' && (
                        <path
                          d={edgePreviewPath(
                            workflowInteraction.startX,
                            workflowInteraction.startY,
                            workflowInteraction.currentX,
                            workflowInteraction.currentY,
                          )}
                          className={`${styles.workflowEdge} ${styles.workflowEdgePreview}`}
                          data-state="running"
                          data-workflow-edge-preview="true"
                        />
                      )}
                    </svg>
                    {graph.nodes.map((node) => (
                      <WorkflowNodeCard
                        key={node.id}
                        node={node}
                        agents={agents}
                        currentAgentId={currentAgentId}
                        userName={userName}
                        userAvatarUrl={userAvatarUrl}
                        agentMap={agentMap}
                        selected={selectedNodeId === node.id}
                        connectTarget={Boolean(connectFromNodeId && connectFromNodeId !== node.id)}
                        dragging={workflowInteraction?.type === 'node' && workflowInteraction.nodeId === node.id}
                        onClick={handleWorkflowNodeClick}
                        onPointerDown={handleWorkflowNodePointerDown}
                        onStartConnectDrag={handleWorkflowPortConnectDrag}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
          <aside className={styles.workflowInspector} aria-label="工作流状态">
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorTitle}>执行概览</div>
              <div className={styles.workflowInspectorGrid}>
                <span>节点 <strong>{graph.nodes.length}</strong></span>
                <span>任务 <strong>{graph.taskCount}</strong></span>
                <span>活动 <strong>{graph.activeCount}</strong></span>
                <span>异常 <strong>{graph.errorCount}</strong></span>
              </div>
            </div>
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorTitle}>调度总监</div>
              <div className={styles.workflowDirectorPanel}>
                <div className={styles.workflowDirectorSummary}>
                  <span>总监群监督</span>
                  <strong>{directorSupervisors.length}</strong>
                </div>
                <div className={styles.workflowDirectorSummary}>
                  <span>待复核</span>
                  <strong>{directorReviewTasks.length}</strong>
                </div>
                <div className={styles.workflowDirectorSummary}>
                  <span>阻塞</span>
                  <strong>{directorBlockedTasks.length}</strong>
                </div>
              </div>
              <div className={styles.workflowDirectorMembers}>
                {directorSupervisors.length > 0 ? directorSupervisors.map((supervisor) => (
                  <button
                    key={supervisor.id}
                    type="button"
                    className={styles.workflowDirectorMember}
                    data-workflow-supervisor-id={supervisor.id}
                    onClick={() => handleDirectorSupervisorClick(supervisor.nodeId)}
                  >
                    <MemberAvatar info={supervisor.info} className={styles.workflowNodeAvatarImg} />
                    <span>{supervisor.info.displayName}</span>
                  </button>
                )) : (
                  <div className={styles.workflowEditorHint}>暂无项目经理或管理员，总监群监督会在派发时使用频道成员兜底。</div>
                )}
              </div>
            </div>
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorHeaderRow}>
                <div className={styles.workflowInspectorTitle}>运行记录时间线</div>
                <button
                  type="button"
                  className={styles.workflowTimelineClearButton}
                  onClick={handleClearTimeline}
                  disabled={timelineItems.length === 0 && workflowRunSnapshots.length === 0}
                >
                  清空
                </button>
              </div>
              {workflowReplayItem && (
                <div className={styles.workflowReplayPanel} data-workflow-replay-active="true">
                  <div className={styles.workflowReplayHead}>
                    <span>{'\u56de\u653e'}</span>
                    <strong>{workflowReplayItem.label}</strong>
                  </div>
                  <div className={styles.workflowReplayMeta}>
                    <span>{workflowReplayItem.time}</span>
                    {workflowReplayItem.agentName && <span>{workflowReplayItem.agentName}</span>}
                    <span>{nodeStateLabel(workflowReplayItem.state)}</span>
                  </div>
                  <div className={styles.workflowReplaySnapshot}>
                    <div><span>{'\u8f93\u5165'}</span>{detailText(workflowReplayItem.input)}</div>
                    <div><span>{'\u8f93\u51fa'}</span>{detailText(workflowReplayItem.output)}</div>
                    {workflowReplayItem.failure && <div><span>{'\u5931\u8d25'}</span>{workflowReplayItem.failure}</div>}
                  </div>
                  <div className={styles.workflowReplayActions}>
                    <button
                      type="button"
                      className={styles.workflowTimelineReplayButton}
                      onClick={() => setWorkflowReplayPlaying((playing) => !playing)}
                    >
                      {workflowReplayPlaying ? '\u6682\u505c' : '\u64ad\u653e'}
                    </button>
                    <button type="button" className={styles.workflowTimelineReplayButton} onClick={() => stepWorkflowReplay(-1)}>
                      {'\u4e0a\u4e00\u6761'}
                    </button>
                    <button type="button" className={styles.workflowTimelineReplayButton} onClick={() => stepWorkflowReplay(1)}>
                      {'\u4e0b\u4e00\u6761'}
                    </button>
                    <button
                      type="button"
                      className={styles.workflowTimelineReplayButton}
                      onClick={() => {
                        setWorkflowReplayPlaying(false);
                        if (timelineItems[0]) focusWorkflowTimelineItem(timelineItems[0]);
                      }}
                    >
                      {'\u91cd\u7f6e'}
                    </button>
                    <button
                      type="button"
                      className={styles.workflowTimelineReplayButton}
                      disabled={workflowReplayRerunning || !customWorkflowNodes.some((node) => node.id === workflowReplayItem.nodeId)}
                      onClick={() => void handleRerunWorkflowReplayItem()}
                    >
                      {workflowReplayRerunning ? '\u91cd\u8dd1\u4e2d' : '\u91cd\u8dd1\u8282\u70b9'}
                    </button>
                    <button
                      type="button"
                      className={styles.workflowTimelineDeleteButton}
                      onClick={() => {
                        setWorkflowReplayPlaying(false);
                        setWorkflowReplayItemId('');
                      }}
                    >
                      {'\u505c\u6b62'}
                    </button>
                  </div>
                </div>
              )}
              <div className={styles.workflowTimeline} data-workflow-timeline-count={timelineItems.length}>
                {timelineItems.length === 0 ? (
                  <div className={styles.workflowEditorHint}>暂无运行记录</div>
                ) : timelineItems.map((item) => (
                  <div
                    key={item.id}
                    className={styles.workflowTimelineItem}
                    data-state={item.state}
                    data-replay-active={workflowReplayItemId === item.id ? 'true' : undefined}
                    data-workflow-node-id={item.nodeId}
                  >
                    <div className={styles.workflowTimelineHead}>
                      <div className={styles.workflowTimelineSummary}>
                        <span>{item.time}</span>
                        <strong>记录：{item.label}</strong>
                      </div>
                      <div className={styles.workflowTimelineActions}>
                        <button
                          type="button"
                          className={styles.workflowTimelineReplayButton}
                          aria-label={`Replay workflow timeline item: ${item.label}`}
                          onClick={() => handleReplayTimelineItem(item)}
                        >
                          {'\u56de\u653e'}
                        </button>
                        <button
                          type="button"
                          className={styles.workflowTimelineDeleteButton}
                          aria-label={`删除时间线记录：${item.label}`}
                          onClick={() => handleDeleteTimelineItem(item.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    {item.agentName && <div className={styles.workflowTimelineAgent}>Agent：{item.agentName}</div>}
                    {item.retryState && <div className={styles.workflowTimelineDetail}>重试状态：{item.retryState}</div>}
                    <div className={styles.workflowTimelineDetail}>输入：{detailText(item.input)}</div>
                    <div className={styles.workflowTimelineDetail}>输出：{detailText(item.output)}</div>
                    {item.failure && <div className={styles.workflowTimelineFailure}>失败原因：{item.failure}</div>}
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorTitle}>画布编辑</div>
              {connectFromNodeId ? (
                <div className={styles.workflowEditorHint}>正在从选中节点连线，点击另一个节点作为终点。</div>
              ) : selectedCustomNode ? (
                <div className={styles.workflowEditorFields}>
                  <label className={styles.workflowEditorField}>
                    <span>节点名称</span>
                    <input
                      value={selectedCustomNode.title}
                      onChange={(event) => updateCustomWorkflowNode(selectedCustomNode.id, { title: event.target.value })}
                    />
                  </label>
                  <label className={styles.workflowEditorField}>
                    <span>执行目标</span>
                    <textarea
                      rows={4}
                      value={selectedCustomNode.prompt}
                      onChange={(event) => updateCustomWorkflowNode(selectedCustomNode.id, { prompt: event.target.value })}
                    />
                  </label>
                  <label className={styles.workflowEditorField}>
                    <span>指挥智能体</span>
                    <select
                      value={selectedCustomNode.agentId}
                      onChange={(event) => updateCustomWorkflowNode(selectedCustomNode.id, { agentId: event.target.value })}
                    >
                      <option value="">自动分配</option>
                      {(workflowChannelMembers.length ? workflowChannelMembers : agents.map(agent => agent.id)).map((agentId) => {
                        const info = resolveChannelMember(agentId, userName, userAvatarUrl, agents, currentAgentId, agentMap);
                        return <option key={agentId} value={agentId}>{info.displayName}</option>;
                      })}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`${styles.workflowWindowButton} ${styles.workflowWindowDangerButton}`}
                    onClick={handleDeleteSelectedNode}
                  >
                    删除节点
                  </button>
                </div>
              ) : (
                <div className={styles.workflowEditorHint}>选择自定义节点后可编辑名称、目标和执行智能体。</div>
              )}
            </div>
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorTitle}>小地图</div>
              <div className={styles.workflowMiniMap}>
                {graph.nodes.map((node) => (
                  <span
                    key={node.id}
                    data-state={node.state}
                    style={{
                      left: `${(node.x / graph.width) * 100}%`,
                      top: `${(node.y / graph.height) * 100}%`,
                      width: `${Math.max(4, (node.w / graph.width) * 100)}%`,
                      height: `${Math.max(4, (node.h / graph.height) * 100)}%`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className={styles.workflowInspectorSection}>
              <div className={styles.workflowInspectorTitle}>图例</div>
              <div className={styles.workflowLegend}>
                {(['running', 'done', 'blocked', 'error', 'idle'] as WorkflowNode['state'][]).map((state) => (
                  <span key={state} data-state={state}>
                    <i />{nodeStateLabel(state)}
                  </span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
  return pageMode ? workflowWindow : createPortal(workflowWindow, document.body);
}
