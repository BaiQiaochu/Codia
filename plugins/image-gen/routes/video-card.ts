/**
 * image-gen/routes/video-card.js
 *
 * Provider video generation card. Kept separate from image cards to avoid
 * mixed image/video renderer branches in generated HTML.
 */
import path from "node:path";

const VIDEO_MIME = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const VIDEO_EXTS = new Set(Object.keys(VIDEO_MIME));

export default function (app, ctx) {
  app.get("/video-card", (c) => {
    const batchId = c.req.query("batch");
    if (!batchId) return c.text("Missing batch parameter", 400);

    const store = ctx._mediaGen?.store;
    const tasks = store?.getByBatch(batchId) || [];
    const token = c.req.query("token") || "";
    const mediaBase = `/api/plugins/${ctx.pluginId}`;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const gsapCss = c.req.query("gsap-css") || "";
    const hasPending = tasks.some((t) => t.status === "pending");
    const ratio = tasks[0]?.params?.ratio || "16:9";
    const [rw, rh] = ratio.split(":").map(Number);
    const cssRatio = (rw && rh) ? `${rw}/${rh}` : "16/9";
    const generatedDir = path.join(ctx.dataDir, "generated");
    const pollApi = `${mediaBase}/tasks/batch/${encodeURIComponent(batchId)}${tokenParam}`;

    const cellsHtml = tasks.length
      ? tasks.map((task) => renderVideoCell({ task, mediaBase, tokenParam, generatedDir })).join("")
      : `<div class="failed">Task not found</div>`;

    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
${gsapCss ? `<link rel="stylesheet" href="${escAttr(gsapCss)}">` : ""}
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;max-width:100%;overflow:auto}
body{background:var(--bg-card,#FCFAF5);padding:8px;font-family:var(--font-sans,system-ui,sans-serif);color:var(--text,#292522)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(188px,1fr));gap:8px;width:100%;max-width:100%}
.video-card{width:100%;max-width:100%;overflow:hidden;border:1px solid color-mix(in srgb,var(--border,#ddd) 78%,transparent);border-radius:12px;background:color-mix(in srgb,var(--bg,#fff) 92%,transparent);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.preview{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:${cssRatio};max-height:360px;border:0;background:#111;cursor:zoom-in;overflow:hidden}
.preview video{display:block;width:100%;height:100%;max-width:100%;max-height:360px;object-fit:contain}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:7px;border-top:1px solid color-mix(in srgb,var(--border,#ddd) 62%,transparent)}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent,#8A6F4D) 24%,var(--border,#ddd));background:color-mix(in srgb,var(--bg,#fff) 86%,transparent);color:var(--text,#292522);font:600 12px/1 var(--font-sans,system-ui,sans-serif);text-decoration:none;cursor:pointer}
.skeleton{aspect-ratio:${cssRatio};max-height:360px;background:linear-gradient(90deg,#f0ede8 25%,#e8e4de 50%,#f0ede8 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:12px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.failed{padding:12px;color:#b23b32;font-size:12px;line-height:1.5}
</style></head>
<body><div class="grid">${cellsHtml}</div>
<script>
(function(){
  var pollApi = ${JSON.stringify(pollApi)};
  var mediaBase = ${JSON.stringify(mediaBase)};
  var tokenParam = ${JSON.stringify(tokenParam)};
  var generatedDir = ${JSON.stringify(generatedDir)};
  var hasPending = ${hasPending ? "true" : "false"};
  var POLL_MS = 2000;
  var ERROR_BACKOFF_MS = 3000;
  var timer = null;
  var videoMime = ${JSON.stringify(VIDEO_MIME)};

  function extOf(file){ var match = String(file || '').match(/\\.([^.]+)$/); return match ? match[1].toLowerCase() : ''; }
  function enc(value){ return encodeURIComponent(String(value || '')); }
  function joinGeneratedPath(file) {
    var sep = generatedDir.indexOf('\\\\') >= 0 ? '\\\\' : '/';
    return generatedDir.replace(/[\\\\/]+$/, '') + sep + file;
  }
  function payloadFor(file) {
    var ext = extOf(file);
    return {
      fileName: file,
      name: file,
      path: joinGeneratedPath(file),
      kind: 'video',
      ext: ext,
      mime: videoMime[ext] || 'video/mp4',
      url: mediaBase + '/media/' + enc(file) + tokenParam,
      downloadUrl: mediaBase + '/media/download/' + enc(file) + tokenParam
    };
  }
  function clear(node){ while (node.firstChild) node.removeChild(node.firstChild); }
  function addAction(parent, label, href, name) {
    var action = document.createElement(href ? 'a' : 'button');
    action.className = 'action';
    action.textContent = label;
    if (href) {
      action.href = href;
      action.download = name || '';
    } else {
      action.type = 'button';
      action.dataset.action = 'open';
    }
    parent.appendChild(action);
  }
  function appendVideoCard(cell, payload) {
    clear(cell);
    var card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.media = JSON.stringify(payload);
    var preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'preview';
    preview.dataset.action = 'open';
    var video = document.createElement('video');
    video.src = payload.url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    preview.appendChild(video);
    var actions = document.createElement('div');
    actions.className = 'actions';
    addAction(actions, 'Open');
    addAction(actions, 'Save', payload.downloadUrl, payload.name);
    card.appendChild(preview);
    card.appendChild(actions);
    cell.appendChild(card);
  }
  function appendText(cell, className, text) {
    clear(cell);
    var node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    cell.appendChild(node);
  }
  function updateCell(cell, task) {
    if (task.status === 'done' && task.files && task.files.length) appendVideoCard(cell, payloadFor(task.files[0]));
    else if (task.status === 'failed') appendText(cell, 'failed', task.failReason || 'Video generation failed');
    else appendText(cell, 'skeleton', '');
  }
  function findCell(taskId) {
    var safe = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (safe !== String(taskId)) return null;
    return document.querySelector('[data-task-id="' + safe + '"]');
  }
  async function poll() {
    timer = null;
    try {
      var res = await fetch(pollApi, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      var data = await res.json();
      var tasks = (data && data.tasks) || [];
      var stillPending = false;
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        if (task.status === 'pending') stillPending = true;
        var cell = findCell(task.taskId);
        if (!cell || cell.dataset.state === task.status) continue;
        updateCell(cell, task);
        cell.dataset.state = task.status;
      }
      notifyResize();
      if (stillPending) timer = setTimeout(poll, POLL_MS);
    } catch (e) {
      timer = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }
  function notifyResize() {
    parent.postMessage({ type: 'resize-request', payload: { width: document.body.scrollWidth, height: document.body.scrollHeight } }, '*');
  }
  function openVideo(card) {
    if (!card) return;
    try { parent.postMessage({ type: 'media-open-request', payload: JSON.parse(card.dataset.media || '{}') }, '*'); } catch (e) {}
  }
  document.addEventListener('click', function(event) {
    var target = event.target;
    var opener = target && target.closest ? target.closest('[data-action="open"]') : null;
    if (!opener) return;
    event.preventDefault();
    openVideo(opener.closest('.video-card'));
  });
  requestAnimationFrame(function() {
    notifyResize();
    parent.postMessage({ type: 'ready' }, '*');
  });
  new ResizeObserver(notifyResize).observe(document.body);
  if (hasPending) timer = setTimeout(poll, POLL_MS);
})();
</script>
</body></html>`);
  });
}

function renderVideoCell({ task, mediaBase, tokenParam, generatedDir }) {
  const state = task.status || "pending";
  return `<div class="cell" data-task-id="${escAttr(task.taskId)}" data-state="${escAttr(state)}">${renderVideoCellInner({
    task,
    mediaBase,
    tokenParam,
    generatedDir,
  })}</div>`;
}

function renderVideoCellInner({ task, mediaBase, tokenParam, generatedDir }) {
  if (task.status === "done" && task.files?.length) {
    const payload = videoPayload(task.files[0], mediaBase, tokenParam, generatedDir);
    if (!payload) return `<div class="failed">Unsupported video output</div>`;
    return renderVideoCard(payload);
  }
  if (task.status === "failed") return `<div class="failed">${esc(task.failReason || "Video generation failed")}</div>`;
  return `<div class="skeleton" aria-label="Generating video"></div>`;
}

function videoPayload(file, mediaBase, tokenParam, generatedDir) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return null;
  return {
    fileName: file,
    name: file,
    path: path.join(generatedDir, file),
    kind: "video",
    ext,
    mime: VIDEO_MIME[ext] || "video/mp4",
    url: `${mediaBase}/media/${encodeURIComponent(file)}${tokenParam}`,
    downloadUrl: `${mediaBase}/media/download/${encodeURIComponent(file)}${tokenParam}`,
  };
}

function renderVideoCard(payload) {
  return `<div class="video-card" data-media="${escAttr(JSON.stringify(payload))}">`
    + `<button class="preview" type="button" data-action="open">`
    + `<video src="${escAttr(payload.url)}" preload="metadata" muted playsinline></video>`
    + `</button>`
    + `<div class="actions">`
    + `<button class="action" type="button" data-action="open">Open</button>`
    + `<a class="action" href="${escAttr(payload.downloadUrl)}" download="${escAttr(payload.name)}">Save</a>`
    + `</div></div>`;
}

function esc(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(value) {
  return esc(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
