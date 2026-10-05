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

function escJs(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderMindMapHtml({ mode = "card", themeCss = "", token = "", filePath = "" } = {}) {
  const isPage = mode === "page";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${themeCss ? `<link rel="stylesheet" href="${escAttr(themeCss)}">` : ""}
<title>思维导图</title>
<style>
*{box-sizing:border-box}
:root{
  color-scheme:light dark;
  --mm-bg:var(--bg,Canvas);
  --mm-panel:var(--bg-card,var(--bg,Canvas));
  --mm-hover:var(--overlay-subtle,var(--bg-hover,rgba(128,128,128,0.08)));
  --mm-selected:var(--accent-light,rgba(var(--accent-rgb,67,109,104),0.10));
  --mm-border:var(--overlay-light,var(--border,rgba(128,128,128,0.16)));
  --mm-border-strong:var(--overlay-medium,var(--border,rgba(128,128,128,0.22)));
  --mm-text:var(--text,var(--text-primary,CanvasText));
  --mm-muted:var(--text-muted,var(--text-light,color-mix(in srgb,var(--mm-text) 58%,transparent)));
  --mm-accent:var(--accent,Highlight);
  --mm-danger:var(--danger,#b42318);
  --mm-radius-card:var(--radius-card,10px);
  --mm-radius-control:var(--radius-sm,6px);
  --mm-focus:rgba(var(--accent-rgb,67,109,104),0.24);
  --mm-node-line:rgba(var(--accent-rgb,67,109,104),0.30);
}
html,body{margin:0;width:100%;height:100%;background:var(--mm-bg);color:var(--mm-text);font-family:var(--font-ui,var(--font-sans,"Segoe UI","PingFang SC",sans-serif))}
body{padding:${isPage ? "14px" : "8px"};overflow:hidden}
.shell{height:${isPage ? "calc(100vh - 28px)" : "100%"};display:grid;grid-template-rows:auto 1fr;gap:10px;min-height:0}
.mind-map-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;border:1px solid var(--mm-border);border-radius:var(--mm-radius-card);background:var(--mm-panel)}
.title{font-size:${isPage ? "15px" : "14px"};font-weight:700;margin-right:auto;letter-spacing:0;color:var(--mm-text)}
input{height:32px;border:1px solid var(--mm-border);border-radius:var(--mm-radius-control);background:var(--mm-bg);color:var(--mm-text);padding:0 10px;min-width:260px;font:inherit;outline:none}
input::placeholder{color:var(--mm-muted)}
input:focus{border-color:var(--mm-accent);box-shadow:0 0 0 2px var(--mm-focus)}
button{height:32px;border:1px solid var(--mm-border);border-radius:var(--mm-radius-control);background:transparent;color:var(--mm-text);padding:0 11px;font:inherit;font-weight:600;cursor:pointer}
button:hover{border-color:var(--mm-border-strong);background:var(--mm-hover)}
button:disabled{cursor:not-allowed;opacity:.55}
button.danger{color:var(--mm-danger)}
.main{display:grid;grid-template-columns:${isPage ? "minmax(0,1fr) 300px" : "1fr"};gap:10px;min-height:0}
.mind-map-canvas,.side{border:1px solid var(--mm-border);border-radius:var(--mm-radius-card);background:var(--mm-panel);min-height:0;overflow:auto}
.mind-map-canvas{position:relative;padding:16px}
.side{padding:12px;display:flex;flex-direction:column;gap:8px}
.side button{width:100%}
.mind-map-stage{position:relative;min-width:560px;min-height:100%;display:flex;align-items:center;gap:28px;padding:12px}
.mind-map-root{flex:0 0 auto;max-width:220px;padding:12px 16px;border:1px solid rgba(var(--accent-rgb,67,109,104),0.28);border-left:3px solid var(--mm-accent);border-radius:var(--mm-radius-control);background:var(--mm-selected);color:var(--mm-text);font-weight:700;font-size:15px;letter-spacing:0;cursor:pointer}
.mind-map-root.selected{border-color:rgba(var(--accent-rgb,67,109,104),0.42);box-shadow:0 0 0 2px var(--mm-focus)}
.mind-map-branches{display:grid;gap:10px;align-content:center;min-width:260px}
.mind-map-branch{--branch-color:var(--mm-accent);display:flex;align-items:flex-start;gap:0}
.mind-map-connector{width:36px;height:18px;border-bottom:1px solid var(--mm-node-line);border-radius:0 0 0 12px;flex:0 0 36px}
.mind-map-group{display:grid;gap:7px}
.mind-map-node{display:inline-flex;align-items:center;max-width:260px;width:max-content;padding:8px 12px;border:1px solid var(--mm-border);border-left:2px solid var(--mm-node-line);border-radius:var(--mm-radius-control);background:var(--mm-panel);color:var(--mm-text);font-weight:600;cursor:pointer}
.mind-map-node:hover,.mind-map-root:hover{background:var(--mm-hover)}
.mind-map-node.selected{background:var(--mm-selected);border-color:rgba(var(--accent-rgb,67,109,104),0.36);box-shadow:0 0 0 2px var(--mm-focus)}
.mind-map-children{display:grid;gap:6px;margin-left:20px;padding-left:14px;border-left:1px solid var(--mm-node-line)}
.empty,.hint{color:var(--mm-muted);font-size:13px;line-height:1.6}
.mind-map-canvas>.empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center}
.field{display:grid;gap:7px;margin-bottom:12px}
.field label{font-size:12px;color:var(--mm-muted);font-weight:700}
.field input{min-width:0;width:100%}
.status{font-size:12px;color:var(--mm-muted);word-break:break-word}
@media(max-width:760px){.main{grid-template-columns:1fr}.side{max-height:240px}.mind-map-toolbar input{min-width:0;width:100%}.mind-map-stage{min-width:520px}}
</style>
</head>
<body>
<div class="shell">
  <div class="mind-map-toolbar">
    <div class="title">思维导图</div>
    <input id="pathInput" placeholder="XMind 文件路径" value="${escAttr(filePath)}">
    <button id="loadBtn">加载</button>
    <button id="saveBtn">保存</button>
  </div>
  <div class="main">
    <div id="canvas" class="mind-map-canvas"><div class="empty">载入或新建 XMind 文件后即可编辑思维导图。</div></div>
    <aside class="side">
      <div class="field">
        <label>已选择节点</label>
        <input id="titleInput" placeholder="选择一个节点" disabled>
      </div>
      <button id="renameBtn">重命名</button>
      <button id="addBtn">添加子节点</button>
      <button id="deleteBtn" class="danger">删除</button>
      <p class="hint">当前编辑器只使用你加载的文件路径，不读取其他会话。</p>
      <p id="status" class="status"></p>
    </aside>
  </div>
</div>
<script>
const API="/api/plugins/mind-map";
const TOKEN=${escJs(token)};
const TEXT={
  noMap:"尚未加载思维导图。",
  emptyChildren:"添加子节点开始构建这张思维导图。",
  pathRequired:"请先填写文件路径。",
  loadFailed:"加载失败。",
  loaded:"已加载 ",
  saved:"已保存。",
  saveFailed:"保存失败。",
  newTopic:"新主题",
  topic:"主题",
  nodeAdded:"已添加节点。",
  addFailed:"添加失败。",
  renamed:"已重命名。",
  renameFailed:"重命名失败。",
  deleted:"已删除。",
  deleteFailed:"删除失败。"
};
let state={filePath:${escJs(filePath)},root:null,selectedId:null};
const el=(id)=>document.getElementById(id);
function apiHeaders(json=false){const h={}; if(json) h["content-type"]="application/json"; if(TOKEN) h.authorization="Bearer "+TOKEN; return h;}
function setStatus(text){el("status").textContent=text||"";}
function selected(){return findNode(state.root,state.selectedId);}
function findNode(node,id){if(!node||!id)return null;if(node.id===id)return node;for(const child of node.children||[]){const found=findNode(child,id);if(found)return found;}return null;}
function colorFor(){return "var(--mm-accent)";}
function selectNode(id){state.selectedId=id;render();}
function nodePill(node,className,color){const pill=document.createElement("button");pill.type="button";pill.className=className+(node.id===state.selectedId?" selected":"");pill.style.setProperty("--branch-color",color);pill.textContent=node.title||TEXT.topic;pill.onclick=()=>selectNode(node.id);return pill;}
function renderBranch(node,depth,index){const color=colorFor(depth,index);const row=document.createElement("div");row.className="mind-map-branch";row.style.setProperty("--branch-color",color);const connector=document.createElement("div");connector.className="mind-map-connector";const group=document.createElement("div");group.className="mind-map-group";group.appendChild(nodePill(node,"mind-map-node",color));if(node.children&&node.children.length){const kids=document.createElement("div");kids.className="mind-map-children";node.children.forEach((child,childIndex)=>kids.appendChild(renderBranch(child,depth+1,childIndex)));group.appendChild(kids);}row.appendChild(connector);row.appendChild(group);return row;}
function render(){const canvas=el("canvas");canvas.innerHTML="";if(!state.root){canvas.innerHTML='<div class="empty">'+TEXT.noMap+'</div>';return;}const stage=document.createElement("div");stage.className="mind-map-stage";stage.appendChild(nodePill(state.root,"mind-map-root","var(--mm-accent)"));const branches=document.createElement("div");branches.className="mind-map-branches";(state.root.children||[]).forEach((child,index)=>branches.appendChild(renderBranch(child,1,index)));if(!(state.root.children||[]).length){const empty=document.createElement("div");empty.className="empty";empty.textContent=TEXT.emptyChildren;branches.appendChild(empty);}stage.appendChild(branches);canvas.appendChild(stage);const node=selected();el("titleInput").disabled=!node;el("titleInput").value=node?node.title:"";el("renameBtn").disabled=!node;el("addBtn").disabled=!node;el("deleteBtn").disabled=!node||node.id===state.root.id;window.parent&&window.parent.postMessage({type:"resize-request",payload:{height:document.body.scrollHeight,width:960}},"*");}
async function load(){const filePath=el("pathInput").value.trim();if(!filePath){setStatus(TEXT.pathRequired);return;}const res=await fetch(API+"/tree?path="+encodeURIComponent(filePath),{headers:apiHeaders()});const data=await res.json().catch(()=>({error:res.statusText||TEXT.loadFailed}));if(!res.ok||data.error){setStatus(data.error||TEXT.loadFailed);return;}state.filePath=data.filePath;state.root=data.root;state.selectedId=data.root.id;setStatus(TEXT.loaded+data.fileName);render();}
async function save(){if(!state.root||!state.filePath)return;const res=await fetch(API+"/save",{method:"POST",headers:apiHeaders(true),body:JSON.stringify({path:state.filePath,root:state.root})});const data=await res.json();setStatus(res.ok&&data.ok?TEXT.saved:(data.error||TEXT.saveFailed));}
async function add(){const node=selected();if(!node)return;const title=TEXT.newTopic;const res=await fetch(API+"/nodes",{method:"POST",headers:apiHeaders(true),body:JSON.stringify({path:state.filePath,parentId:node.id,title})});const data=await res.json();if(!res.ok||data.error){setStatus(data.error||TEXT.addFailed);return;}state.root=data.root;state.selectedId=data.node.id;setStatus(TEXT.nodeAdded);render();}
async function rename(){const node=selected();const title=el("titleInput").value.trim();if(!node||!title)return;const res=await fetch(API+"/nodes/"+encodeURIComponent(node.id),{method:"PATCH",headers:apiHeaders(true),body:JSON.stringify({path:state.filePath,title})});const data=await res.json();if(!res.ok||data.error){setStatus(data.error||TEXT.renameFailed);return;}state.root=data.root;setStatus(TEXT.renamed);render();}
async function del(){const node=selected();if(!node||node.id===state.root.id)return;const res=await fetch(API+"/nodes/"+encodeURIComponent(node.id),{method:"DELETE",headers:apiHeaders(true),body:JSON.stringify({path:state.filePath})});const data=await res.json();if(!res.ok||data.error){setStatus(data.error||TEXT.deleteFailed);return;}state.root=data.root;state.selectedId=state.root.id;setStatus(TEXT.deleted);render();}
el("loadBtn").onclick=load;el("saveBtn").onclick=save;el("addBtn").onclick=add;el("renameBtn").onclick=rename;el("deleteBtn").onclick=del;
window.addEventListener("load",()=>{window.parent&&window.parent.postMessage({type:"ready"},"*"); if(state.filePath) load(); else render();});
</script>
</body>
</html>`;
}