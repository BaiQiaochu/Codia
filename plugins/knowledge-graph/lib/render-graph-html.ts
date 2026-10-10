// @ts-nocheck
function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}

function escJsString(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderGraphHtml({ mode = "card", codiaCss = "", token = "" } = {}) {
  const isPage = mode === "page";
  const tokenLiteral = escJsString(token);
  const fixedWidth = 960;
  const fixedHeight = 680;
  const graphMinHeight = isPage ? 560 : 500;
  const graphViewportHeight = isPage ? 560 : 500;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${codiaCss ? `<link rel="stylesheet" href="${escAttr(codiaCss)}">` : ""}
<title>知识图谱</title>
<style>
*{box-sizing:border-box}
:root{
  --kg-bg:var(--bg,#f8f5ed);
  --kg-panel:var(--bg-card,#fcfaf5);
  --kg-panel-strong:var(--bg-card,#fffdf8);
  --kg-input:var(--bg-input,var(--input-bg,var(--kg-panel-strong)));
  --kg-hover:var(--bg-hover,var(--kg-accent-soft));
  --kg-border:var(--border,rgba(83,125,150,.22));
  --kg-text:var(--text-primary,var(--text,#3b3d3f));
  --kg-muted:var(--text-muted,var(--text-light,#8e9196));
  --kg-accent:var(--accent,#537d96);
  --kg-accent-soft:var(--accent-light,rgba(83,125,150,.08));
  --kg-danger:var(--danger,#8b3a3a);
  --kg-success:var(--green,#7bae7f);
  --kg-shadow:0 1px 3px var(--shadow,rgba(59,61,63,.09));
  --kg-shadow-strong:0 8px 24px var(--shadow,rgba(59,61,63,.09));
  --kg-radius-panel:var(--radius-card,var(--radius-md,8px));
  --kg-radius-control:var(--radius-sm,var(--radius-input,4px));
  --kg-edge:color-mix(in srgb,var(--kg-text) 34%,transparent);
  --kg-edge-weak:color-mix(in srgb,var(--kg-accent) 64%,transparent);
  --kg-node-stroke:color-mix(in srgb,var(--kg-panel) 88%,transparent);
  --kg-focus:color-mix(in srgb,var(--kg-accent) 48%,transparent);
}
html,body{
  width:100%;
  height:100%;
  margin:0;
  background-color:var(--kg-bg);
  background-image:var(--bg-texture,none);
  color:var(--kg-text);
  font-family:var(--font-sans,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif);
}
body{
  padding:${isPage ? "10px" : "8px"};
  overflow:${isPage ? "hidden" : "hidden"};
}
.shell{
  display:flex;
  flex-direction:column;
  gap:12px;
  width:100%;
  height:${isPage ? "calc(100vh - 20px)" : "100%"};
  min-height:0;
  overflow:hidden;
}
.topbar{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  flex:0 0 auto;
  flex-wrap:wrap;
}
.titlebox{min-width:0}
.title{
  font-size:${isPage ? "22px" : "18px"};
  font-weight:800;
  letter-spacing:.02em;
}
.subtitle{
  margin-top:4px;
  font-size:12px;
  line-height:1.55;
  color:var(--kg-muted);
}
.toolbar{
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
  margin-left:auto;
}
button{
  border:1px solid var(--kg-border);
  border-radius:var(--kg-radius-control);
  background:var(--kg-panel-strong);
  color:var(--kg-text);
  padding:7px 12px;
  font:600 12px/1 var(--font-sans,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif);
  cursor:pointer;
  transition:background .14s ease,border-color .14s ease,color .14s ease,opacity .14s ease;
}
button:hover{
  background:var(--kg-hover);
}
button:disabled{
  opacity:.56;
  cursor:not-allowed;
}
button.danger{
  color:var(--kg-danger);
  border-color:rgba(180,35,24,.34);
}
.layout{
  display:grid;
  grid-template-columns:minmax(0,1.45fr) minmax(360px,.85fr);
  gap:14px;
  align-items:${isPage ? "stretch" : "start"};
  min-height:0;
  flex:1 1 auto;
  overflow:${isPage ? "hidden" : "visible"};
  width:100%;
  max-width:100%;
}
.graph-panel,
.panel{
  border:1px solid var(--kg-border);
  border-radius:var(--kg-radius-panel);
  background:color-mix(in srgb,var(--kg-panel) 96%,transparent);
  box-shadow:var(--kg-shadow);
}
.graph-panel{
  position:relative;
  overflow:hidden;
  flex:0 0 auto;
  align-self:stretch;
  width:100%;
  min-width:0;
  height:${graphViewportHeight}px;
  min-height:${graphViewportHeight}px;
  max-height:${graphViewportHeight}px;
  background:
    radial-gradient(circle at 18% 16%,color-mix(in srgb,var(--kg-accent) 9%,transparent),transparent 24%),
    color-mix(in srgb,var(--kg-panel-strong) 98%,transparent);
  box-shadow:var(--kg-shadow-strong),inset 0 0 0 1px color-mix(in srgb,var(--kg-panel) 70%,transparent);
  contain:layout paint;
}
.graph-column,
.sidebar{
  display:flex;
  flex-direction:column;
  gap:12px;
  min-width:0;
  min-height:0;
  max-height:${isPage ? "100%" : "none"};
  overflow:${isPage ? "auto" : "visible"};
  overscroll-behavior:contain;
  scrollbar-gutter:stable;
  padding:1px;
}
.graph-column .source-list{
  max-height:${isPage ? "220px" : "120px"};
}
.panel{
  flex:0 0 auto;
  padding:14px;
  min-height:0;
  overflow:hidden;
}
.panel h2{
  margin:0 0 10px;
  font-size:13px;
  font-weight:800;
  letter-spacing:.02em;
}
.graph-meta{
  display:grid;
  grid-template-columns:repeat(4,minmax(96px,1fr));
  gap:8px;
  margin-top:10px;
}
.stat{
  border:1px solid var(--kg-border);
  border-radius:var(--kg-radius-panel);
  background:var(--kg-panel-strong);
  padding:10px;
  min-height:64px;
  min-width:0;
}
.stat-label{
  font-size:11px;
  color:var(--kg-muted);
}
.stat-value{
  margin-top:4px;
  font-size:18px;
  font-weight:800;
}
.detail-block{
  display:grid;
  gap:8px;
}
.detail-title{
  font-size:16px;
  font-weight:800;
}
.detail-meta,
.detail-body,
.empty-text,
.build-msg,
.source-meta,
.archive-meta,
.archive-status{
  font-size:12px;
  line-height:1.6;
  color:var(--kg-muted);
}
.detail-body{
  color:var(--kg-text);
  white-space:pre-wrap;
  word-break:break-word;
}
.detail-actions,
.builder-row,
.archive-toolbar,
.archive-actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  align-items:center;
}
.source-list,
.archive-list,
.task-list{
  display:grid;
  gap:10px;
  max-height:${isPage ? "260px" : "220px"};
  overflow:auto;
  overscroll-behavior:contain;
  padding-right:2px;
}
.source-card,
.archive-card,
.task-card{
  border:1px solid var(--kg-border);
  border-radius:var(--kg-radius-panel);
  background:var(--kg-panel-strong);
  padding:12px;
  min-width:0;
}
.archive-card.active{
  border-color:rgba(138,111,77,.56);
  box-shadow:inset 0 0 0 1px rgba(138,111,77,.24);
}
.task-card.current{
  border-color:rgba(138,111,77,.56);
  box-shadow:inset 0 0 0 1px rgba(138,111,77,.24);
}
.archive-title,
.source-title,
.task-title{
  font-size:13px;
  font-weight:800;
}
.task-head,
.task-actions{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:8px;
  flex-wrap:wrap;
}
.task-status-line,
.task-meta,
.task-progress{
  font-size:12px;
  line-height:1.6;
  color:var(--kg-muted);
}
.task-progress{
  color:var(--kg-text);
}
.source-text{
  margin-top:8px;
  font-size:12px;
  line-height:1.65;
  color:var(--kg-text);
  white-space:pre-wrap;
  word-break:break-word;
  max-height:180px;
  overflow:auto;
}
.builder{
  display:${isPage ? "grid" : "none"};
  grid-template-columns:minmax(0,1fr);
  gap:8px;
}
.builder-panel{
  flex:0 0 auto;
}
.builder input,
.builder textarea{
  width:100%;
  border:1px solid var(--kg-border);
  border-radius:var(--kg-radius-control);
  background:var(--kg-input);
  color:var(--kg-text);
  font:13px/1.55 var(--font-sans,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif);
  padding:11px 12px;
  outline:none;
}
.builder input:focus,
.builder textarea:focus{
  border-color:var(--kg-focus);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--kg-accent) 14%,transparent);
}
.builder textarea{
  height:clamp(140px,22vh,240px);
  min-height:140px;
  max-height:280px;
  resize:vertical;
}
.builder-row label{
  display:flex;
  align-items:center;
  gap:6px;
  flex:1 1 220px;
  min-width:220px;
  font-size:12px;
  color:var(--kg-muted);
}
.builder-row input[type="checkbox"]{
  flex:0 0 auto;
}
.legend{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:6px 10px;
  border-radius:var(--kg-radius-control);
  border:1px solid var(--kg-border);
  background:var(--kg-panel-strong);
  font-size:11px;
  color:var(--kg-muted);
}
.dot{
  width:8px;
  height:8px;
  border-radius:999px;
}
svg{
  display:block;
  width:100%;
  height:100%;
  user-select:none;
  touch-action:none;
}
.empty{
  position:absolute;
  inset:0;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px;
  text-align:center;
  pointer-events:none;
}
.empty[hidden]{
  display:none!important;
}
.node{
  cursor:grab;
}
.node:active{
  cursor:grabbing;
}
.node circle{
  stroke:var(--kg-node-stroke);
  stroke-width:2px;
  filter:drop-shadow(0 4px 8px color-mix(in srgb,var(--kg-text) 18%,transparent));
}
.node text{
  paint-order:stroke;
  stroke:var(--kg-node-stroke);
  stroke-width:4px;
  stroke-linejoin:round;
  font-size:11px;
  font-weight:800;
  pointer-events:none;
}
.node.selected circle{
  stroke:var(--kg-text);
  stroke-width:3px;
}
.node.related circle{
  stroke:var(--kg-accent);
  stroke-width:3px;
}
.node.pinned circle{
  stroke-dasharray:4 3;
}
.edge{
  stroke-linecap:round;
  vector-effect:non-scaling-stroke;
  pointer-events:none;
  stroke:var(--kg-edge);
  opacity:.9;
}
.edge-strong{
  stroke-dasharray:none;
}
.edge-weak{
  stroke:var(--kg-edge-weak);
  stroke-dasharray:7 7;
  stroke-dashoffset:0;
  animation:kg-edge-flow 1.45s linear infinite;
  opacity:.74;
}
.edge.related{
  stroke:var(--kg-accent);
  opacity:.86;
}
.edge-weak.related{
  stroke-width:2.8px;
  stroke-dasharray:10 6;
  animation-duration:.8s;
  opacity:1;
}
.edge-label{
  font-size:9px;
  fill:var(--kg-muted);
  paint-order:stroke;
  stroke:var(--kg-node-stroke);
  stroke-width:3px;
  stroke-linejoin:round;
  pointer-events:none;
}
@keyframes kg-edge-flow{
  to{stroke-dashoffset:-28}
}
@media (prefers-reduced-motion:reduce){
  .edge-weak{
    animation:none;
    stroke-dashoffset:0;
  }
}
@media (max-width:1120px){
  body{
    overflow:${isPage ? "auto" : "hidden"};
  }
  .shell{
    height:${isPage ? "auto" : "100%"};
    min-height:${isPage ? "calc(100vh - 16px)" : "100%"};
  }
  .layout{
    grid-template-columns:1fr;
    align-items:start;
    overflow:visible;
  }
  .graph-column,
  .sidebar{
    max-height:none;
    overflow:visible;
  }
  .graph-panel{
    height:${isPage ? 520 : 460}px;
    min-height:${isPage ? 520 : 460}px;
    max-height:${isPage ? 520 : 460}px;
  }
  .graph-meta{
    grid-template-columns:repeat(2,minmax(0,1fr));
  }
}
@media (max-width:640px){
  body{padding:8px}
  .topbar{gap:8px}
  .toolbar{width:100%;justify-content:flex-start}
  .title{font-size:18px}
  .graph-meta{grid-template-columns:1fr 1fr}
  .graph-panel{
    height:${isPage ? 460 : 420}px;
    min-height:${isPage ? 460 : 420}px;
    max-height:${isPage ? 460 : 420}px;
  }
}
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="titlebox">
      <div class="title">知识图谱</div>
      <div class="subtitle" id="meta">正在加载图谱数据...</div>
    </div>
    <div class="toolbar">
      <button id="refresh" type="button">刷新</button>
      <button id="viewCurrent" type="button">查看当前图谱</button>
      <button id="clear" type="button" class="danger">清空当前图谱</button>
    </div>
  </div>

  <div class="layout">
    <div class="graph-column">
      <div class="graph-panel" id="graphCard">
        <svg id="graph" role="img" aria-label="知识图谱"></svg>
        <div class="empty" id="empty" hidden>
          <div class="empty-text" id="emptyText">暂无知识图谱数据。先构建一份图谱，再查看节点关系。</div>
        </div>
      </div>

      <div class="panel source-panel">
        <h2>来源文档</h2>
        <div class="source-list" id="sourceList">
          <div class="empty-text">选中节点后，这里会显示对应的知识库文档内容。</div>
        </div>
      </div>

      <div class="panel legend-panel">
        <h2>图例</h2>
        <div class="legend">
          <span class="chip"><span class="dot" style="background:#10b981"></span>概念</span>
          <span class="chip"><span class="dot" style="background:#3b82f6"></span>主题</span>
          <span class="chip"><span class="dot" style="background:#f97316"></span>实体</span>
          <span class="chip"><span class="dot" style="background:#8b5cf6"></span>片段</span>
        </div>
      </div>
    </div>

    <div class="sidebar">
      <div class="panel">
        <h2>图谱统计</h2>
        <div class="graph-meta">
          <div class="stat">
            <div class="stat-label">节点</div>
            <div class="stat-value" id="statNodes">0</div>
          </div>
          <div class="stat">
            <div class="stat-label">关系</div>
            <div class="stat-value" id="statEdges">0</div>
          </div>
          <div class="stat">
            <div class="stat-label">来源</div>
            <div class="stat-value" id="statSources">0</div>
          </div>
          <div class="stat">
            <div class="stat-label">状态</div>
            <div class="stat-value" id="statState">未构建</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>图谱归档</h2>
        <div class="archive-toolbar">
          <button id="archiveCurrent" type="button">归档当前图谱</button>
          <div class="archive-status" id="archiveStatus">当前正在查看：当前图谱</div>
        </div>
        <div class="archive-list" id="archiveList">
          <div class="empty-text">暂无历史归档。</div>
        </div>
      </div>

      <div class="panel">
        <h2>构建任务</h2>
        <div class="archive-status" id="taskSummary">当前没有构建任务。</div>
        <div class="archive-toolbar">
          <button id="cancelAllTasks" type="button" class="danger">取消全部任务</button>
        </div>
        <div class="task-list" id="taskList">
          <div class="empty-text">暂无构建任务。</div>
        </div>
      </div>

      <div class="panel">
        <h2>节点详情</h2>
        <div class="detail-block">
          <div class="detail-title" id="detailTitle">未选择节点</div>
          <div class="detail-meta" id="detailMeta">点击节点后可查看类型、描述和来源文档。</div>
          <div class="detail-body" id="detailBody">拖动节点可以固定位置，双击节点可以取消固定。</div>
          <div class="detail-actions">
            <button id="deleteNode" type="button" class="danger" disabled>删除当前节点</button>
          </div>
        </div>
      </div>

      <div class="panel builder builder-panel">
        <h2>构建图谱</h2>
        <input id="buildTitle" placeholder="标题，可选">
        <textarea id="buildText" placeholder="粘贴文档、笔记或对话摘要，用于生成图谱。"></textarea>
        <div class="builder-row">
          <button id="build" type="button">构建</button>
          <button id="cancelBuild" type="button" class="danger" disabled>取消</button>
          <label><input id="rebuild" type="checkbox"> 归档当前图谱后重建</label>
        </div>
        <div class="build-msg" id="buildMsg">当前模式使用本地抽取逻辑，支持异步构建和多图谱归档。</div>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  var API = "/api/plugins/knowledge-graph";
  var TOKEN = ${tokenLiteral};
  var IS_PAGE = ${isPage ? "true" : "false"};
  var FIXED_WIDTH = ${fixedWidth};
  var FIXED_HEIGHT = ${fixedHeight};
  var GRAPH_VIEWPORT_HEIGHT = ${graphViewportHeight};
  var GRAPH_SAFE_PADDING_X = 76;
  var GRAPH_SAFE_PADDING_TOP = 52;
  var GRAPH_SAFE_PADDING_BOTTOM = 72;
  var STRONG_EDGE_THRESHOLD = 0.7;
  var svg = document.getElementById("graph");
  var graphCard = document.getElementById("graphCard");
  var meta = document.getElementById("meta");
  var empty = document.getElementById("empty");
  var emptyText = document.getElementById("emptyText");
  var refreshBtn = document.getElementById("refresh");
  var viewCurrentBtn = document.getElementById("viewCurrent");
  var clearBtn = document.getElementById("clear");
  var archiveCurrentBtn = document.getElementById("archiveCurrent");
  var archiveList = document.getElementById("archiveList");
  var archiveStatus = document.getElementById("archiveStatus");
  var taskList = document.getElementById("taskList");
  var taskSummary = document.getElementById("taskSummary");
  var cancelAllTasksBtn = document.getElementById("cancelAllTasks");
  var deleteNodeBtn = document.getElementById("deleteNode");
  var buildBtn = document.getElementById("build");
  var cancelBuildBtn = document.getElementById("cancelBuild");
  var buildMsg = document.getElementById("buildMsg");
  var buildTitle = document.getElementById("buildTitle");
  var buildText = document.getElementById("buildText");
  var rebuildInput = document.getElementById("rebuild");
  var detailTitle = document.getElementById("detailTitle");
  var detailMeta = document.getElementById("detailMeta");
  var detailBody = document.getElementById("detailBody");
  var sourceList = document.getElementById("sourceList");
  var statNodes = document.getElementById("statNodes");
  var statEdges = document.getElementById("statEdges");
  var statSources = document.getElementById("statSources");
  var statState = document.getElementById("statState");

  var colors = {
    concept: "#10b981",
    topic: "#3b82f6",
    entity: "#f97316",
    fragment: "#8b5cf6",
    tag: "#ec4899"
  };

  var state = {
    status: null,
    archives: [],
    tasks: [],
    currentArchiveId: null,
    currentTaskId: null,
    currentTaskStatus: "",
    taskTimer: 0,
    nodes: [],
    edges: [],
    sources: [],
    selectedNodeId: null,
    relatedNodeIds: new Set(),
    relatedEdgeIds: new Set(),
    edgeEls: new Map(),
    edgeLabelEls: new Map(),
    nodeEls: new Map(),
    width: 640,
    height: GRAPH_VIEWPORT_HEIGHT,
    alpha: 0,
    raf: 0,
    dragging: null,
    docRequest: "",
    lastResize: { width: 0, height: 0 }
  };

  function apiUrl(path) {
    var url = API + path;
    if (!TOKEN) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  }

  function withArchive(path) {
    if (!state.currentArchiveId) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "archiveId=" + encodeURIComponent(state.currentArchiveId);
  }

  async function fetchJson(path, init) {
    var response = await fetch(apiUrl(path), init || {});
    var data = {};
    try { data = await response.json(); } catch (error) {}
    if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function post(type, payload) {
    try { parent.postMessage({ type: type, payload: payload || {} }, "*"); } catch (error) {}
  }

  function resize() {
    if (!IS_PAGE) {
      if (Math.abs(FIXED_WIDTH - state.lastResize.width) < 1 && Math.abs(FIXED_HEIGHT - state.lastResize.height) < 1) return;
      state.lastResize = { width: FIXED_WIDTH, height: FIXED_HEIGHT };
      post("resize-request", { width: FIXED_WIDTH, height: FIXED_HEIGHT });
      return;
    }

    var doc = document.documentElement;
    var width = Math.max(document.body.scrollWidth, doc.scrollWidth, FIXED_WIDTH);
    var height = Math.max(document.body.scrollHeight, doc.scrollHeight, FIXED_HEIGHT);
    if (Math.abs(width - state.lastResize.width) < 1 && Math.abs(height - state.lastResize.height) < 1) return;
    state.lastResize = { width: width, height: height };
    post("resize-request", { width: width, height: height });
  }

  function ready() {
    resize();
    post("ready");
  }

  function text(el, value) {
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function isArchiveView() {
    return Boolean(state.currentArchiveId);
  }

  function isTaskActiveStatus(status) {
    return status === "queued" || status === "pending" || status === "running" || status === "cancelling";
  }

  function isTaskCurrentStatus(status) {
    return status === "pending" || status === "running" || status === "cancelling";
  }

  function isTaskCancelableStatus(status) {
    return status === "queued" || status === "pending" || status === "running";
  }

  function currentTaskIdFromStatus() {
    return String(
      (state.status && state.status.current_task_id) ||
      state.currentTaskId ||
      ""
    ).trim();
  }

  function currentExecutableTask() {
    var taskId = currentTaskIdFromStatus();
    if (!taskId) return null;
    for (var index = 0; index < state.tasks.length; index += 1) {
      if (state.tasks[index] && state.tasks[index].id === taskId) return state.tasks[index];
    }
    if (!isTaskCurrentStatus(state.currentTaskStatus)) return null;
    return {
      id: taskId,
      status: state.currentTaskStatus,
      progress: state.status && state.status.building_progress,
      message: state.status && state.status.building_message,
      queue_position: 0,
      meta: {}
    };
  }

  function syncTaskTelemetry() {
    if (!state.status) state.status = {};
    var queuedTaskIds = (state.tasks || [])
      .filter(function(task){ return task && task.status === "queued"; })
      .map(function(task){ return task.id; });
    var currentTaskId = String(state.status.current_task_id || state.currentTaskId || "").trim();
    state.status.queued_task_count = queuedTaskIds.length;
    state.status.queued_task_ids = queuedTaskIds;
    state.status.active_task_count = (currentTaskId ? 1 : 0) + queuedTaskIds.length;
  }

  function hasLiveTasks() {
    if (Array.isArray(state.tasks) && state.tasks.some(function(task){ return isTaskActiveStatus(task && task.status); })) {
      return true;
    }
    if (state.status && Number(state.status.active_task_count || 0) > 0) return true;
    return Boolean(currentTaskIdFromStatus());
  }

  function formatDateTime(value) {
    if (!value) return "";
    return String(value).replace("T", " ").slice(0, 19);
  }

  function normalizeTaskMessage(message) {
    var textValue = String(message || "").trim();
    if (!textValue) return "";
    if (textValue === "Queued") return "已加入队列";
    if (textValue === "Waiting to start knowledge graph build...") return "等待开始构建知识图谱...";
    if (textValue === "Queued behind the current knowledge graph build") {
      return "排队中，位于当前知识图谱构建任务之后";
    }
    if (textValue === "Knowledge graph build cancelled before execution") {
      return "知识图谱构建在开始前已取消";
    }
    if (textValue === "Knowledge graph build cancelled for this session") {
      return "已取消当前会话的知识图谱构建任务";
    }
    if (textValue === "Knowledge graph build cancelled") return "知识图谱构建已取消";
    if (textValue === "Running knowledge graph build...") return "正在构建知识图谱...";
    if (textValue === "Building knowledge graph...") return "正在构建知识图谱...";
    if (textValue === "Cancelling knowledge graph build...") return "正在取消知识图谱构建...";

    var queuedMatch = textValue.match(/^Queued behind (\\d+) knowledge graph builds$/);
    if (queuedMatch) return "排队中，前方还有 " + queuedMatch[1] + " 个知识图谱构建任务";

    var buildingMatch = textValue.match(/^Building knowledge graph \\((\\d+)\\/(\\d+)\\)\\.\\.\\.$/);
    if (buildingMatch) {
      return "正在构建知识图谱（" + buildingMatch[1] + "/" + buildingMatch[2] + "）...";
    }

    return textValue;
  }

  function normalizeTaskRecord(task) {
    if (!task || typeof task !== "object") return task;
    var normalized = Object.assign({}, task);
    if (normalized.message) normalized.message = normalizeTaskMessage(normalized.message);
    return normalized;
  }

  function normalizeStatusPayload(status) {
    var normalized = status && typeof status === "object" ? Object.assign({}, status) : {};
    if (normalized.building_message) {
      normalized.building_message = normalizeTaskMessage(normalized.building_message);
    }
    return normalized;
  }

  function sortTasks(tasks) {
    var currentId = currentTaskIdFromStatus();
    return (tasks || []).slice().sort(function(a, b){
      var aCurrent = currentId && a && a.id === currentId ? 1 : 0;
      var bCurrent = currentId && b && b.id === currentId ? 1 : 0;
      if (aCurrent !== bCurrent) return bCurrent - aCurrent;

      var aLive = isTaskActiveStatus(a && a.status) ? 1 : 0;
      var bLive = isTaskActiveStatus(b && b.status) ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;

      var aQueued = a && a.status === "queued" ? 1 : 0;
      var bQueued = b && b.status === "queued" ? 1 : 0;
      if (aQueued !== bQueued) return bQueued - aQueued;

      if (aQueued && bQueued) {
        var aQueue = Math.max(0, Number(a.queue_position) || 0);
        var bQueue = Math.max(0, Number(b.queue_position) || 0);
        if (aQueue !== bQueue) return aQueue - bQueue;
      }

      var aUpdated = Date.parse((a && a.updated_at) || (a && a.created_at) || 0) || 0;
      var bUpdated = Date.parse((b && b.updated_at) || (b && b.created_at) || 0) || 0;
      return bUpdated - aUpdated;
    });
  }

  function upsertTask(task) {
    if (!task || !task.id) return null;
    var index = -1;
    for (var i = 0; i < state.tasks.length; i += 1) {
      if (state.tasks[i] && state.tasks[i].id === task.id) {
        index = i;
        break;
      }
    }

    var merged = normalizeTaskRecord(
      index >= 0
        ? Object.assign({}, state.tasks[index], task)
        : Object.assign({}, task)
    );

    if (index >= 0) {
      state.tasks.splice(index, 1, merged);
    } else {
      state.tasks.push(merged);
    }

    state.tasks = sortTasks(state.tasks);
    return merged;
  }

  function currentArchive() {
    return state.archives.find(function(item){ return item.id === state.currentArchiveId; }) || null;
  }

  function setEmptyVisible(visible, message) {
    empty.hidden = !visible;
    if (visible && message) text(emptyText, message);
  }

  function clearSourceList(message) {
    if (!sourceList) return;
    while (sourceList.firstChild) sourceList.removeChild(sourceList.firstChild);
    var emptyNode = document.createElement("div");
    emptyNode.className = "empty-text";
    emptyNode.textContent = message || "选中节点后，这里会显示对应的知识库文档内容。";
    sourceList.appendChild(emptyNode);
  }

  function nodeTypeLabel(type) {
    if (type === "topic") return "主题";
    if (type === "entity") return "实体";
    if (type === "fragment") return "片段";
    if (type === "tag") return "标签";
    return "概念";
  }

  function taskStatusLabel(status) {
    if (status === "queued") return "排队中";
    if (status === "pending") return "等待启动";
    if (status === "running") return "构建中";
    if (status === "cancelling") return "取消中";
    if (status === "completed") return "已完成";
    if (status === "failed") return "已失败";
    if (status === "cancelled") return "已取消";
    return "未知状态";
  }

  function taskProgressText(task) {
    if (!task) return "";
    if (task.status === "queued") {
      var position = Math.max(1, Number(task.queue_position) || 1);
      return position === 1 ? "队列位置：紧随当前任务" : "队列位置：" + position;
    }
    if (task.status === "completed") {
      var completedResult = task.result || {};
      var completedStats = completedResult.stats || {};
      return "构建完成：节点 " + (completedStats.node_count || 0) + "，关系 " + (completedStats.edge_count || 0) + "，来源 " + (completedStats.source_count || 0);
    }
    if (task.status === "failed") {
      return "错误：" + ((task.error && task.error.message) || task.message || "未知错误");
    }
    if (task.status === "cancelled") {
      return normalizeTaskMessage(task.message) || "构建任务已取消";
    }
    return "进度：" + Math.max(0, Number(task.progress) || 0) + "%";
  }

  function taskSummaryText() {
    var total = Array.isArray(state.tasks) ? state.tasks.length : 0;
    var liveTasks = state.tasks.filter(function(task){ return isTaskActiveStatus(task && task.status); });
    var queuedTasks = state.tasks.filter(function(task){ return task && task.status === "queued"; });
    var currentTask = currentExecutableTask();

    if (!total) return "当前没有构建任务。";
    if (currentTask) return "当前有 1 个执行中任务，" + queuedTasks.length + " 个排队任务。";
    if (liveTasks.length) return "当前有 " + liveTasks.length + " 个活跃任务。";

    var latest = state.tasks[0];
    return "最近任务：" + taskStatusLabel(latest && latest.status) + (latest && latest.updated_at ? "，更新时间 " + formatDateTime(latest.updated_at) : "。");
  }

  function setControlsState() {
    var readonly = isArchiveView();
    var busy = hasLiveTasks();
    var currentTask = currentExecutableTask();
    if (viewCurrentBtn) viewCurrentBtn.disabled = !readonly;
    if (clearBtn) clearBtn.disabled = readonly || busy;
    if (archiveCurrentBtn) archiveCurrentBtn.disabled = readonly || busy || state.nodes.length === 0;
    if (buildBtn) buildBtn.disabled = readonly;
    if (cancelBuildBtn) cancelBuildBtn.disabled = readonly || !(currentTask && isTaskCancelableStatus(currentTask.status));
    if (cancelAllTasksBtn) cancelAllTasksBtn.disabled = readonly || !busy;
    if (deleteNodeBtn) deleteNodeBtn.disabled = readonly || busy || !state.selectedNodeId;

    if (taskList) {
      var cancelButtons = taskList.querySelectorAll("button[data-task-cancel]");
      cancelButtons.forEach(function(button){
        var status = button.getAttribute("data-task-status") || "";
        button.disabled = readonly || !isTaskCancelableStatus(status);
      });
    }
  }

  function updateArchiveStatus() {
    if (!archiveStatus) return;
    var archive = currentArchive();
    if (archive) {
      text(archiveStatus, "当前正在查看：归档《" + archive.title + "》");
      return;
    }
    text(archiveStatus, "当前正在查看：当前图谱");
  }

  function renderArchives() {
    if (!archiveList) return;
    while (archiveList.firstChild) archiveList.removeChild(archiveList.firstChild);
    var liveTasks = hasLiveTasks();

    if (!state.archives.length) {
      var emptyNode = document.createElement("div");
      emptyNode.className = "empty-text";
      emptyNode.textContent = "暂无历史归档。";
      archiveList.appendChild(emptyNode);
      updateArchiveStatus();
      setControlsState();
      return;
    }

    state.archives.forEach(function(archive){
      var card = document.createElement("div");
      card.className = "archive-card" + (state.currentArchiveId === archive.id ? " active" : "");
      card.setAttribute("data-archive-id", archive.id);

      var titleEl = document.createElement("div");
      titleEl.className = "archive-title";
      titleEl.textContent = archive.title || archive.id;
      card.appendChild(titleEl);

      var metaEl = document.createElement("div");
      metaEl.className = "archive-meta";
      metaEl.textContent =
        "创建于 " + String(archive.created_at || "").replace("T", " ").slice(0, 19) +
        " · 节点 " + (archive.node_count || 0) +
        " · 关系 " + (archive.edge_count || 0);
      card.appendChild(metaEl);

      var actions = document.createElement("div");
      actions.className = "archive-actions";

      var viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.textContent = "查看";
      viewBtn.addEventListener("click", function(){ switchArchiveView(archive.id); });
      actions.appendChild(viewBtn);

      var restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.textContent = "恢复";
      restoreBtn.disabled = liveTasks;
      restoreBtn.addEventListener("click", function(){ restoreArchive(archive.id); });
      actions.appendChild(restoreBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "danger";
      deleteBtn.textContent = "删除";
      deleteBtn.disabled = liveTasks;
      deleteBtn.addEventListener("click", function(){ deleteArchive(archive.id); });
      actions.appendChild(deleteBtn);

      card.appendChild(actions);
      archiveList.appendChild(card);
    });

    updateArchiveStatus();
    setControlsState();
  }

  function renderTasks() {
    if (!taskList) return;
    state.tasks = sortTasks(state.tasks);

    while (taskList.firstChild) taskList.removeChild(taskList.firstChild);

    if (!state.tasks.length) {
      var emptyNode = document.createElement("div");
      emptyNode.className = "empty-text";
      emptyNode.textContent = "暂无构建任务。";
      taskList.appendChild(emptyNode);
      if (taskSummary) text(taskSummary, "当前没有构建任务。");
      setControlsState();
      return;
    }

    state.tasks.forEach(function(task){
      var card = document.createElement("div");
      card.className = "task-card" + (task.id === currentTaskIdFromStatus() ? " current" : "");
      card.setAttribute("data-task-id", task.id);

      var head = document.createElement("div");
      head.className = "task-head";

      var titleWrap = document.createElement("div");

      var titleEl = document.createElement("div");
      titleEl.className = "task-title";
      titleEl.textContent =
        (task.meta && task.meta.title) ||
        (task.result && task.result.title) ||
        ("任务 " + String(task.id || "").slice(0, 8));
      titleWrap.appendChild(titleEl);

      var statusEl = document.createElement("div");
      statusEl.className = "task-status-line";
      statusEl.textContent = taskStatusLabel(task.status);
      titleWrap.appendChild(statusEl);
      head.appendChild(titleWrap);

      var actions = document.createElement("div");
      actions.className = "task-actions";
      if (IS_PAGE) {
        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "danger";
        cancelBtn.textContent = task.status === "queued" ? "移出队列" : "取消";
        cancelBtn.setAttribute("data-task-cancel", "1");
        cancelBtn.setAttribute("data-task-id", task.id);
        cancelBtn.setAttribute("data-task-status", task.status || "");
        cancelBtn.disabled = !isTaskCancelableStatus(task.status);
        cancelBtn.addEventListener("click", function(){ cancelTaskById(task.id); });
        actions.appendChild(cancelBtn);
      }
      head.appendChild(actions);
      card.appendChild(head);

      var metaEl = document.createElement("div");
      metaEl.className = "task-meta";
      var metaParts = ["状态：" + taskStatusLabel(task.status)];
      if (task.meta && task.meta.document_count) metaParts.push("文档 " + task.meta.document_count);
      if (task.updated_at) metaParts.push("更新于 " + formatDateTime(task.updated_at));
      metaEl.textContent = metaParts.join(" · ");
      card.appendChild(metaEl);

      var progressEl = document.createElement("div");
      progressEl.className = "task-progress";
      progressEl.textContent = taskProgressText(task);
      card.appendChild(progressEl);

      if (task.message) {
        var messageEl = document.createElement("div");
        messageEl.className = "task-status-line";
        messageEl.textContent = normalizeTaskMessage(task.message);
        card.appendChild(messageEl);
      }

      taskList.appendChild(card);
    });

    if (taskSummary) text(taskSummary, taskSummaryText());
    setControlsState();
  }

  function updateSummary() {
    var status = state.status || {};
    var archive = currentArchive();
    var currentTask = currentExecutableTask();
    var queuedCount = Math.max(
      0,
      Number(status.queued_task_count || state.tasks.filter(function(task){ return task && task.status === "queued"; }).length) || 0
    );
    var liveCount = Math.max(
      0,
      Number(status.active_task_count || state.tasks.filter(function(task){ return isTaskActiveStatus(task && task.status); }).length) || 0
    );
    text(statNodes, String(state.nodes.length));
    text(statEdges, String(state.edges.length));
    text(statSources, String(Array.isArray(state.sources) ? state.sources.length : 0));

    if (archive) {
      text(statState, "归档视图");
      text(
        meta,
        "正在查看归档《" + archive.title + "》。节点 " + state.nodes.length +
          "，关系 " + state.edges.length +
          "，来源 " + (state.sources || []).length
      );
    } else if (currentTask) {
      text(statState, "构建中");
      text(
        meta,
        (normalizeTaskMessage(currentTask.message || status.building_message) || "正在构建知识图谱...") +
          "（" + Math.max(0, Number(currentTask.progress || status.building_progress) || 0) + "%）" +
          (queuedCount ? "，后续排队 " + queuedCount + " 个任务" : "")
      );
    } else if (liveCount > 0) {
      text(statState, "排队中");
      text(meta, "当前有 " + liveCount + " 个活跃任务，请稍后查看结果。");
    } else if (state.nodes.length) {
      text(statState, "就绪");
      text(
        meta,
        "图谱已加载。节点 " + state.nodes.length +
          "，关系 " + state.edges.length +
          "，来源 " + (state.sources || []).length +
          (status.last_built_at ? "，最近构建于 " + formatDateTime(status.last_built_at) : "")
      );
    } else {
      text(statState, "未构建");
      text(meta, "暂无知识图谱数据。先构建一份图谱，再查看节点关系。");
    }

    updateArchiveStatus();
    renderTasks();
    setControlsState();
  }

  function setDetail(node) {
    if (!node) {
      text(detailTitle, "未选择节点");
      text(detailMeta, "点击节点后可查看类型、描述和来源文档。");
      text(detailBody, "拖动节点可以固定位置，双击节点可以取消固定。");
      return;
    }
    text(detailTitle, node.name || "未命名节点");
    text(detailMeta, "类型：" + nodeTypeLabel(node.node_type) + " · 来源 " + (((node.source_note_ids || []).length) || 0));
    text(detailBody, node.description || "这个节点暂时没有补充描述。");
  }

  function renderSources(sources) {
    if (!sourceList) return;
    while (sourceList.firstChild) sourceList.removeChild(sourceList.firstChild);
    if (!sources || !sources.length) {
      clearSourceList("当前节点没有保存来源文档。");
      return;
    }

    sources.forEach(function(source){
      var card = document.createElement("div");
      card.className = "source-card";

      var titleEl = document.createElement("div");
      titleEl.className = "source-title";
      titleEl.textContent = source.title || source.id || "未命名文档";
      card.appendChild(titleEl);

      var metaEl = document.createElement("div");
      metaEl.className = "source-meta";
      metaEl.textContent = "来源 ID: " + (source.id || "未知");
      card.appendChild(metaEl);

      var textEl = document.createElement("div");
      textEl.className = "source-text";
      textEl.textContent = source.text || "这个来源没有保存正文。";
      card.appendChild(textEl);

      sourceList.appendChild(card);
    });
  }

  function clearSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    state.edgeEls = new Map();
    state.edgeLabelEls = new Map();
    state.nodeEls = new Map();
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function(key){ el.setAttribute(key, attrs[key]); });
    return el;
  }

  function nodeColor(type) {
    return colors[type] || colors.concept;
  }

  function clampValue(value, min, max) {
    if (max < min) return (min + max) / 2;
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : (min + max) / 2));
  }

  function graphSafeBounds() {
    var horizontal = Math.min(GRAPH_SAFE_PADDING_X, Math.max(32, state.width / 2 - 12));
    var top = Math.min(GRAPH_SAFE_PADDING_TOP, Math.max(30, state.height / 2 - 12));
    var bottom = Math.min(GRAPH_SAFE_PADDING_BOTTOM, Math.max(38, state.height / 2 - 12));
    return {
      left: horizontal,
      right: state.width - horizontal,
      top: top,
      bottom: state.height - bottom
    };
  }

  function clampNodePosition(node, x, y) {
    var bounds = graphSafeBounds();
    var nextX = clampValue(x, bounds.left, bounds.right);
    var nextY = clampValue(y, bounds.top, bounds.bottom);
    if (node) {
      node.x = nextX;
      node.y = nextY;
      if (node.fx != null) node.fx = nextX;
      if (node.fy != null) node.fy = nextY;
    }
    return { x: nextX, y: nextY };
  }

  function clampAllNodes() {
    state.nodes.forEach(function(node){
      clampNodePosition(node, node.x, node.y);
    });
  }

  function isStrongEdge(edge) {
    return Number(edge && edge.strength) >= STRONG_EDGE_THRESHOLD;
  }

  function updateSize() {
    state.width = Math.max(320, graphCard.clientWidth || 640);
    state.height = Math.max(320, graphCard.clientHeight || GRAPH_VIEWPORT_HEIGHT);
    svg.setAttribute("viewBox", "0 0 " + state.width + " " + state.height);
    clampAllNodes();
  }

  function seedPositions(nodes) {
    var previous = new Map(state.nodes.map(function(node){ return [node.id, node]; }));
    var cx = state.width / 2;
    var cy = state.height / 2;
    var radius = Math.max(88, Math.min(state.width, state.height) * 0.28);

    return nodes.map(function(node, index){
      var existing = previous.get(node.id);
      if (existing && Number.isFinite(existing.x) && Number.isFinite(existing.y)) {
        var reused = Object.assign({}, node, {
          x: existing.x,
          y: existing.y,
          vx: existing.vx || 0,
          vy: existing.vy || 0,
          fx: existing.fx,
          fy: existing.fy
        });
        clampNodePosition(reused, reused.x, reused.y);
        return reused;
      }
      var angle = nodes.length ? (Math.PI * 2 * index / nodes.length) : 0;
      var seeded = Object.assign({}, node, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      });
      clampNodePosition(seeded, seeded.x, seeded.y);
      return seeded;
    });
  }

  function setGraphData(data) {
    updateSize();
    state.sources = Array.isArray(data && data.sources) ? data.sources : [];
    state.nodes = seedPositions(Array.isArray(data && data.nodes) ? data.nodes : []);
    state.edges = Array.isArray(data && data.edges) ? data.edges : [];
    state.relatedNodeIds = new Set();
    state.relatedEdgeIds = new Set();
    state.selectedNodeId = null;
    clearSourceList();
    setDetail(null);
    renderGraph();
    warmupSimulation();
    reheat(0.9);
    setEmptyVisible(state.nodes.length === 0, "暂无知识图谱数据。先构建一份图谱，再查看节点关系。");
    updateSummary();
  }

  function nodeById() {
    var map = new Map();
    state.nodes.forEach(function(node){ map.set(node.id, node); });
    return map;
  }

  function collectNeighborhood(nodeId) {
    var nodeIds = new Set([nodeId]);
    var edgeIds = new Set();
    state.edges.forEach(function(edge){
      if (edge.source_node_id === nodeId || edge.target_node_id === nodeId) {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source_node_id);
        nodeIds.add(edge.target_node_id);
      }
    });
    state.relatedNodeIds = nodeIds;
    state.relatedEdgeIds = edgeIds;
  }

  function updatePositions() {
    var byId = nodeById();

    state.edges.forEach(function(edge){
      var source = byId.get(edge.source_node_id);
      var target = byId.get(edge.target_node_id);
      var line = state.edgeEls.get(edge.id);
      if (!source || !target || !line) return;

      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
      line.classList.toggle("related", state.relatedEdgeIds.has(edge.id));

      var label = state.edgeLabelEls.get(edge.id);
      if (label) {
        label.setAttribute("x", (source.x + target.x) / 2);
        label.setAttribute("y", (source.y + target.y) / 2);
      }
    });

    state.nodes.forEach(function(node){
      var group = state.nodeEls.get(node.id);
      if (!group) return;
      group.setAttribute("transform", "translate(" + node.x + "," + node.y + ")");
      group.classList.toggle("selected", state.selectedNodeId === node.id);
      group.classList.toggle("related", state.relatedNodeIds.has(node.id));
      group.classList.toggle("pinned", node.fx != null && node.fy != null);
    });
  }

  function toSvgPoint(event) {
    if (typeof svg.createSVGPoint !== "function") return { x: 0, y: 0 };
    var point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    var matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
  }

  function endDrag(event) {
    if (!state.dragging) return;
    try { state.dragging.el.releasePointerCapture(event.pointerId); } catch (error) {}
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    state.dragging = null;
    reheat(0.35);
  }

  function onDragMove(event) {
    if (!state.dragging) return;
    event.preventDefault();
    var point = toSvgPoint(event);
    var node = state.dragging.node;
    var clamped = clampNodePosition(node, point.x + state.dragging.dx, point.y + state.dragging.dy);
    node.fx = clamped.x;
    node.fy = clamped.y;
    node.x = node.fx;
    node.y = node.fy;
    node.vx = 0;
    node.vy = 0;
    updatePositions();
  }

  function beginDrag(event, node, el) {
    event.preventDefault();
    event.stopPropagation();
    var point = toSvgPoint(event);
    state.dragging = {
      node: node,
      el: el,
      dx: node.x - point.x,
      dy: node.y - point.y
    };
    node.fx = node.x;
    node.fy = node.y;
    try { el.setPointerCapture(event.pointerId); } catch (error) {}
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    reheat(0.85);
  }

  function renderGraph() {
    clearSvg();

    if (!state.nodes.length) {
      resize();
      return;
    }

    var edgeLayer = svgEl("g");
    var labelLayer = svgEl("g");
    var nodeLayer = svgEl("g");
    svg.appendChild(edgeLayer);
    svg.appendChild(labelLayer);
    svg.appendChild(nodeLayer);

    state.edges.forEach(function(edge){
      var strokeWidth = String(1.5 + Math.max(0, Number(edge.strength) || 0) * 1.4);
      var line = svgEl("line", {
        class: "edge " + (isStrongEdge(edge) ? "edge-strong" : "edge-weak"),
        "stroke-width": strokeWidth
      });
      edgeLayer.appendChild(line);
      state.edgeEls.set(edge.id, line);

      if (edge.description) {
        var label = svgEl("text", { class: "edge-label", "text-anchor": "middle" });
        label.textContent = edge.description.length > 16 ? edge.description.slice(0, 16) + "…" : edge.description;
        labelLayer.appendChild(label);
        state.edgeLabelEls.set(edge.id, label);
      }
    });

    state.nodes.forEach(function(node){
      var group = svgEl("g", {
        class: "node",
        tabindex: "0",
        role: "button",
        "aria-label": node.name
      });

      var circle = svgEl("circle", {
        r: String(node.node_type === "topic" ? 24 : node.node_type === "entity" ? 20 : 18),
        fill: nodeColor(node.node_type)
      });
      var textEl = svgEl("text", {
        "text-anchor": "middle",
        y: String(node.node_type === "topic" ? 38 : 34),
        fill: "currentColor"
      });
      textEl.textContent = node.name.length > 12 ? node.name.slice(0, 12) + "…" : node.name;
      group.appendChild(circle);
      group.appendChild(textEl);

      group.addEventListener("pointerdown", function(event){ beginDrag(event, node, group); });
      group.addEventListener("click", function(event){
        event.stopPropagation();
        selectNode(node);
      });
      group.addEventListener("dblclick", function(event){
        event.preventDefault();
        event.stopPropagation();
        node.fx = null;
        node.fy = null;
        reheat(0.8);
      });
      group.addEventListener("keydown", function(event){
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectNode(node);
        }
      });

      nodeLayer.appendChild(group);
      state.nodeEls.set(node.id, group);
    });

    svg.onclick = function(event) {
      if (event.target === svg) {
        state.selectedNodeId = null;
        state.relatedNodeIds = new Set();
        state.relatedEdgeIds = new Set();
        setDetail(null);
        clearSourceList();
        setControlsState();
        updatePositions();
      }
    };

    updatePositions();
    resize();
  }

  async function loadStatus() {
    var previousTaskId = state.currentTaskId;
    state.status = normalizeStatusPayload(await fetchJson("/status", { cache: "no-store" }));
    var nextTaskId = String((state.status && state.status.current_task_id) || "").trim();
    var nextTaskStatus = String((state.status && state.status.current_task_status) || "").trim();
    state.currentTaskId = nextTaskId || null;
    state.currentTaskStatus = nextTaskId ? (nextTaskStatus || state.currentTaskStatus || "pending") : "";
    syncTaskTelemetry();
    if (!nextTaskId) {
      stopTaskPolling();
    } else if (nextTaskId !== previousTaskId || !state.taskTimer) {
      watchTask(nextTaskId);
    }
    updateSummary();
  }

  async function loadArchives() {
    var data = await fetchJson("/archives", { cache: "no-store" });
    state.archives = Array.isArray(data && data.archives) ? data.archives : [];
    if (state.currentArchiveId && !state.archives.some(function(item){ return item.id === state.currentArchiveId; })) {
      state.currentArchiveId = null;
    }
    renderArchives();
  }

  async function loadTasks() {
    var data = await fetchJson("/tasks?limit=20", { cache: "no-store" });
    state.tasks = sortTasks(
      (Array.isArray(data && data.tasks) ? data.tasks : []).map(function(task){
        return normalizeTaskRecord(task);
      })
    );

    if (!state.currentTaskId) {
      var currentTask = state.tasks.find(function(task){ return task && isTaskCurrentStatus(task.status); }) || null;
      if (currentTask) {
        state.currentTaskId = currentTask.id;
        state.currentTaskStatus = currentTask.status || "pending";
      }
    }

    syncTaskTelemetry();
    renderTasks();
  }

  async function loadGraph() {
    var data = await fetchJson(withArchive("/data"), { cache: "no-store" });
    setGraphData(data || { nodes: [], edges: [], sources: [] });
  }

  async function loadAll() {
    try {
      text(meta, "正在加载知识图谱数据...");
      await Promise.all([loadStatus(), loadArchives(), loadTasks()]);
      await loadGraph();
    } catch (error) {
      state.status = null;
      state.nodes = [];
      state.edges = [];
      state.sources = [];
      state.archives = [];
      state.tasks = [];
      state.currentTaskId = null;
      state.currentTaskStatus = "";
      stopTaskPolling();
      renderArchives();
      renderTasks();
      updateSummary();
      setEmptyVisible(true, "知识图谱加载失败：" + error.message);
      clearSourceList("暂时无法读取来源文档。");
      text(meta, "加载失败：" + error.message);
    } finally {
      resize();
    }
  }

  async function loadNodeSources(node) {
    if (!node) return;
    var requestId = String(node.id) + ":" + Date.now();
    state.docRequest = requestId;
    clearSourceList("正在加载来源文档...");
    try {
      var data = await fetchJson(withArchive("/nodes/" + encodeURIComponent(node.id) + "/sources"), { cache: "no-store" });
      if (state.docRequest !== requestId) return;
      renderSources(Array.isArray(data.sources) ? data.sources : []);
    } catch (error) {
      if (state.docRequest === requestId) {
        clearSourceList("来源文档加载失败：" + error.message);
      }
    }
  }

  function selectNode(node) {
    state.selectedNodeId = node.id;
    collectNeighborhood(node.id);
    setDetail(node);
    setControlsState();
    updatePositions();
    loadNodeSources(node);
  }

  function stopTaskPolling() {
    if (state.taskTimer) {
      clearTimeout(state.taskTimer);
      state.taskTimer = 0;
    }
  }

  function syncTaskStatus(task) {
    var mergedTask = upsertTask(task) || normalizeTaskRecord(task) || task;
    state.status = state.status || {};

    var currentTaskId = String((state.status && state.status.current_task_id) || state.currentTaskId || "").trim();
    var taskIsCurrent = Boolean(mergedTask && mergedTask.id && mergedTask.id === currentTaskId);
    var taskIsExecutable = isTaskCurrentStatus(mergedTask && mergedTask.status);

    if (taskIsCurrent) {
      state.currentTaskStatus = taskIsExecutable ? (mergedTask.status || "") : "";
      state.currentTaskId = taskIsExecutable ? mergedTask.id : null;
      state.status.is_building = taskIsExecutable;
      state.status.building_progress = taskIsExecutable ? Math.max(0, Number(mergedTask.progress) || 0) : 0;
      state.status.building_message = normalizeTaskMessage(mergedTask.message) || null;
      state.status.current_task_id = taskIsExecutable ? mergedTask.id : null;
      state.status.current_task_status = taskIsExecutable ? (mergedTask.status || null) : null;
    } else if (!currentTaskId && taskIsExecutable) {
      state.currentTaskStatus = mergedTask.status || "";
      state.currentTaskId = mergedTask.id;
      state.status.is_building = true;
      state.status.building_progress = Math.max(0, Number(mergedTask.progress) || 0);
      state.status.building_message = normalizeTaskMessage(mergedTask.message) || null;
      state.status.current_task_id = mergedTask.id;
      state.status.current_task_status = mergedTask.status || null;
    }

    syncTaskTelemetry();

    if (buildMsg) {
      if (mergedTask.status === "completed") {
        var result = mergedTask.result || {};
        var stats = result.stats || {};
        text(
          buildMsg,
          "构建完成：节点 " + (stats.node_count || 0) +
            "，关系 " + (stats.edge_count || 0) +
            "，来源 " + (stats.source_count || 0)
        );
      } else if (mergedTask.status === "cancelled") {
        text(buildMsg, normalizeTaskMessage(mergedTask.message) || "知识图谱构建已取消");
      } else if (mergedTask.status === "failed") {
        text(buildMsg, "构建失败：" + ((mergedTask.error && mergedTask.error.message) || mergedTask.message || "未知错误"));
      } else if (mergedTask.status === "cancelling") {
        text(buildMsg, normalizeTaskMessage(mergedTask.message) || "正在取消知识图谱构建...");
      } else if (mergedTask.status === "queued") {
        text(buildMsg, normalizeTaskMessage(mergedTask.message) || "构建任务已进入队列，等待前序任务完成。");
      } else {
        text(
          buildMsg,
          (normalizeTaskMessage(mergedTask.message) || "正在构建知识图谱...") + "（" + (mergedTask.progress || 0) + "%）"
        );
      }
    }

    updateSummary();
  }

  async function pollTask(taskId) {
    try {
      var task = await fetchJson("/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
      syncTaskStatus(task);

      if (isTaskCurrentStatus(task.status)) {
        state.currentTaskId = task.id;
        stopTaskPolling();
        state.taskTimer = setTimeout(function(){ pollTask(task.id); }, 320);
        return;
      }

      state.currentTaskId = null;
      state.currentTaskStatus = "";
      stopTaskPolling();
      await Promise.all([loadStatus(), loadTasks(), loadArchives()]);
      if (!isArchiveView()) {
        await loadGraph();
      }
    } catch (error) {
      state.currentTaskId = null;
      state.currentTaskStatus = "";
      stopTaskPolling();
      if (buildMsg) text(buildMsg, "任务状态读取失败：" + error.message);
      await Promise.all([loadStatus(), loadTasks()]);
    }
  }

  function watchTask(taskId) {
    taskId = String(taskId || "").trim();
    if (!taskId) {
      stopTaskPolling();
      return;
    }
    if (state.currentTaskId === taskId && state.taskTimer) return;
    state.currentTaskId = taskId;
    if (!state.currentTaskStatus) state.currentTaskStatus = "pending";
    stopTaskPolling();
    pollTask(taskId);
  }

  async function cancelTaskById(taskId) {
    if (isArchiveView()) return;

    taskId = String(taskId || "").trim();
    if (!taskId) {
      await Promise.all([loadStatus(), loadTasks()]);
      return;
    }

    var queuedTask = state.tasks.find(function(task){ return task && task.id === taskId; }) || null;
    if (buildMsg) {
      text(buildMsg, queuedTask && queuedTask.status === "queued"
        ? "正在移除排队中的构建任务..."
        : "正在取消知识图谱构建...");
    }

    try {
      var data = await fetchJson("/tasks/" + encodeURIComponent(taskId) + "/cancel", {
        method: "POST"
      });
      if (data && data.task) syncTaskStatus(data.task);
      await Promise.all([loadStatus(), loadTasks(), loadArchives()]);
      var currentTaskId = currentTaskIdFromStatus();
      if (currentTaskId) watchTask(currentTaskId);
      if (!currentTaskId && !isArchiveView()) {
        await loadGraph();
      }
    } catch (error) {
      if (buildMsg) text(buildMsg, "取消失败：" + error.message);
      await Promise.all([loadStatus(), loadTasks()]);
    } finally {
      setControlsState();
      resize();
    }
  }

  async function cancelCurrentBuild() {
    if (isArchiveView()) return;

    var taskId = currentTaskIdFromStatus();
    if (!taskId) {
      await Promise.all([loadStatus(), loadTasks()]);
      return;
    }

    state.currentTaskId = taskId;
    state.currentTaskStatus = "cancelling";
    if (state.status) {
      state.status.is_building = true;
      state.status.current_task_id = taskId;
      state.status.building_message = "正在取消知识图谱构建...";
    }
    if (buildMsg) text(buildMsg, "正在取消知识图谱构建...");
    setControlsState();
    await cancelTaskById(taskId);
  }

  async function cancelAllBuildTasks() {
    if (isArchiveView()) return;

    if (buildMsg) text(buildMsg, "正在取消全部知识图谱构建任务...");
    setControlsState();

    try {
      var data = await fetchJson("/tasks/cancel-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      await Promise.all([loadStatus(), loadTasks(), loadArchives()]);
      var currentTaskId = currentTaskIdFromStatus();
      if (currentTaskId) {
        watchTask(currentTaskId);
      } else if (!isArchiveView()) {
        await loadGraph();
      }
      if (buildMsg) {
        text(
          buildMsg,
          Number(data && data.cancelled_count) > 0
            ? "已取消全部知识图谱构建任务。"
            : "当前没有可取消的构建任务。"
        );
      }
    } catch (error) {
      if (buildMsg) text(buildMsg, "取消失败：" + error.message);
      await Promise.all([loadStatus(), loadTasks()]);
    } finally {
      setControlsState();
      resize();
    }
  }

  async function buildGraph() {
    if (!buildBtn || !buildText) return;
    if (isArchiveView()) {
      text(buildMsg, "归档视图为只读，请先切回当前图谱。");
      return;
    }

    var sourceText = String(buildText.value || "").trim();
    if (!sourceText) {
      text(buildMsg, "请先输入用于构建图谱的文本。");
      return;
    }

    buildBtn.disabled = true;
    text(buildMsg, "正在提交知识图谱构建任务...");
    try {
      var data = await fetchJson("/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: buildTitle ? buildTitle.value : "",
          text: sourceText,
          rebuild: Boolean(rebuildInput && rebuildInput.checked)
        })
      });
      if (data && data.status) {
        state.status = normalizeStatusPayload(data.status);
        state.currentTaskId = String((data.status && data.status.current_task_id) || "").trim() || null;
        state.currentTaskStatus = state.currentTaskId
          ? String((data.status && data.status.current_task_status) || "").trim() || "pending"
          : "";
      }
      if (data && data.task) syncTaskStatus(data.task);
      await Promise.all([loadStatus(), loadTasks(), loadArchives()]);

      var currentTaskId = currentTaskIdFromStatus();
      if (data && data.queued) {
        text(buildMsg, "构建任务已加入队列，完成前序任务后会自动开始。");
      } else {
        text(buildMsg, "构建任务已提交，正在准备执行。");
      }

      if (currentTaskId) watchTask(currentTaskId);
    } catch (error) {
      text(buildMsg, "构建失败：" + error.message);
      await Promise.all([loadStatus(), loadTasks()]);
    } finally {
      setControlsState();
      resize();
    }
  }

  async function createArchive() {
    if (!archiveCurrentBtn) return;
    if (isArchiveView()) {
      text(buildMsg, "归档视图为只读，请先切回当前图谱。");
      return;
    }
    archiveCurrentBtn.disabled = true;
    try {
      await fetchJson("/archives/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (buildMsg) text(buildMsg, "当前图谱已归档。");
      await loadArchives();
    } catch (error) {
      if (buildMsg) text(buildMsg, "归档失败：" + error.message);
    } finally {
      setControlsState();
    }
  }

  async function switchArchiveView(archiveId) {
    state.currentArchiveId = archiveId;
    renderArchives();
    clearSourceList();
    setDetail(null);
    try {
      await loadGraph();
    } catch (error) {
      text(meta, "归档加载失败：" + error.message);
    }
  }

  async function showCurrentGraph() {
    state.currentArchiveId = null;
    renderArchives();
    clearSourceList();
    setDetail(null);
    try {
      await loadGraph();
    } catch (error) {
      text(meta, "图谱加载失败：" + error.message);
    }
  }

  async function restoreArchive(archiveId) {
    if (!confirm("确定恢复这个归档为当前图谱吗？当前图谱会先自动归档。")) return;
    try {
      await fetchJson("/archives/" + encodeURIComponent(archiveId) + "/restore", {
        method: "POST"
      });
      state.currentArchiveId = null;
      await Promise.all([loadStatus(), loadArchives()]);
      await loadGraph();
      if (buildMsg) text(buildMsg, "归档已恢复为当前图谱。");
    } catch (error) {
      if (buildMsg) text(buildMsg, "恢复失败：" + error.message);
    }
  }

  async function deleteArchive(archiveId) {
    if (!confirm("确定删除这个归档吗？删除后无法恢复。")) return;
    try {
      await fetchJson("/archives/" + encodeURIComponent(archiveId), {
        method: "DELETE"
      });
      if (state.currentArchiveId === archiveId) state.currentArchiveId = null;
      await loadArchives();
      await loadGraph();
      if (buildMsg) text(buildMsg, "归档已删除。");
    } catch (error) {
      if (buildMsg) text(buildMsg, "删除归档失败：" + error.message);
    }
  }

  async function clearGraph() {
    if (!clearBtn) return;
    if (isArchiveView()) {
      text(meta, "归档视图为只读，请先切回当前图谱。");
      return;
    }
    if (!confirm("确定清空当前知识图谱吗？该操作不会删除已有归档。")) return;
    clearBtn.disabled = true;
    text(meta, "正在清空当前知识图谱...");
    try {
      await fetchJson("/data", { method: "DELETE" });
      clearSourceList();
      setDetail(null);
      await loadAll();
    } catch (error) {
      text(meta, "清空失败：" + error.message);
    } finally {
      setControlsState();
      resize();
    }
  }

  async function deleteSelectedNode() {
    if (isArchiveView()) {
      text(detailMeta, "归档视图为只读，请先恢复到当前图谱后再编辑。");
      return;
    }
    if (!state.selectedNodeId) return;
    var node = state.nodes.find(function(item){ return item.id === state.selectedNodeId; });
    if (!node) return;
    if (!confirm("确定删除节点“" + node.name + "”吗？相关关系也会一起删除。")) return;

    deleteNodeBtn.disabled = true;
    try {
      await fetchJson("/nodes/" + encodeURIComponent(node.id), { method: "DELETE" });
      clearSourceList();
      setDetail(null);
      await loadAll();
    } catch (error) {
      text(detailMeta, "删除失败：" + error.message);
      setControlsState();
    } finally {
      resize();
    }
  }

  function reheat(alpha) {
    state.alpha = Math.max(state.alpha, alpha || 0.4);
    if (!state.raf) state.raf = requestAnimationFrame(tick);
  }

  function tick() {
    state.raf = 0;
    if (!state.nodes.length) return;
    stepSimulation();
    updatePositions();
    state.alpha *= 0.985;
    if (state.alpha > 0.015 || state.dragging) state.raf = requestAnimationFrame(tick);
  }

  function warmupSimulation() {
    if (!state.nodes.length) return;
    state.alpha = Math.max(state.alpha, 1);
    for (var i = 0; i < 80; i += 1) {
      stepSimulation();
      state.alpha *= 0.985;
    }
    updatePositions();
  }

  function stepSimulation() {
    var nodes = state.nodes;
    var byId = nodeById();
    var alpha = Math.max(0.02, state.alpha);
    var cx = state.width / 2;
    var cy = state.height / 2;
    var linkDistance = Math.max(116, Math.min(220, Math.min(state.width, state.height) * 0.26));
    var charge = 2800;

    for (var i = 0; i < nodes.length; i += 1) {
      for (var j = i + 1; j < nodes.length; j += 1) {
        var a = nodes[i];
        var b = nodes[j];
        var dx = (a.x - b.x) || (Math.random() - 0.5) * 0.1;
        var dy = (a.y - b.y) || (Math.random() - 0.5) * 0.1;
        var dist2 = Math.max(110, dx * dx + dy * dy);
        var force = charge * alpha / dist2;
        if (a.fx == null) { a.vx += dx * force; a.vy += dy * force; }
        if (b.fx == null) { b.vx -= dx * force; b.vy -= dy * force; }
      }
    }

    state.edges.forEach(function(edge){
      var source = byId.get(edge.source_node_id);
      var target = byId.get(edge.target_node_id);
      if (!source || !target) return;
      var dx = target.x - source.x;
      var dy = target.y - source.y;
      var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      var targetDistance = linkDistance + (1 - Math.min(1, Number(edge.strength) || 0.5)) * 48;
      var force = (dist - targetDistance) * 0.015 * alpha;
      if (source.fx == null) { source.vx += dx / dist * force; source.vy += dy / dist * force; }
      if (target.fx == null) { target.vx -= dx / dist * force; target.vy -= dy / dist * force; }
    });

    nodes.forEach(function(node){
      if (node.fx != null && node.fy != null) {
        clampNodePosition(node, node.fx, node.fy);
        node.vx = 0;
        node.vy = 0;
        return;
      }
      node.vx += (cx - node.x) * 0.0055 * alpha;
      node.vy += (cy - node.y) * 0.0055 * alpha;
      node.vx *= 0.62;
      node.vy *= 0.62;
      clampNodePosition(node, node.x + node.vx, node.y + node.vy);
    });
  }

  refreshBtn.addEventListener("click", function(){ loadAll(); });
  if (viewCurrentBtn) viewCurrentBtn.addEventListener("click", showCurrentGraph);
  if (clearBtn) clearBtn.addEventListener("click", clearGraph);
  if (archiveCurrentBtn) archiveCurrentBtn.addEventListener("click", createArchive);
  if (deleteNodeBtn) deleteNodeBtn.addEventListener("click", deleteSelectedNode);
  if (buildBtn) buildBtn.addEventListener("click", buildGraph);
  if (cancelBuildBtn) cancelBuildBtn.addEventListener("click", cancelCurrentBuild);
  if (cancelAllTasksBtn) cancelAllTasksBtn.addEventListener("click", cancelAllBuildTasks);

  window.addEventListener("resize", function(){
    updateSize();
    updatePositions();
    reheat(0.4);
    resize();
  });

  if (IS_PAGE && "ResizeObserver" in window) {
    new ResizeObserver(function(){
      updateSize();
      updatePositions();
      resize();
    }).observe(graphCard || document.body);
  }

  loadAll().finally(ready);
})();
</script>
</body>
</html>`;
}
