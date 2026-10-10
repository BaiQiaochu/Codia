// @ts-nocheck
/**
 * image-gen/routes/card.js
 *
 * Image-only iframe card for generated images. Video and audio cards live in
 * dedicated routes so image rendering never carries video/audio branches.
 */
import path from "node:path";

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const IMAGE_EXTS = new Set(Object.keys(IMAGE_MIME));

export default function (app, ctx) {
  app.get("/card", (c) => {
    const batchId = c.req.query("batch");
    if (!batchId) return c.text("Missing batch parameter", 400);

    const store = ctx._mediaGen?.store;
    const tasks = store?.getByBatch(batchId) || [];
    const token = c.req.query("token") || "";
    const pluginId = ctx.pluginId;
    const mediaBase = `/api/plugins/${pluginId}`;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const codiaCss = c.req.query("codia-css") || "";

    const hasPending = tasks.some((t) => t.status === "pending");
    const ratio = tasks[0]?.params?.ratio || "1:1";
    const [rw, rh] = ratio.split(":").map(Number);
    const cssRatio = (rw && rh) ? `${rw}/${rh}` : "1/1";
    const generatedDir = path.join(ctx.dataDir, "generated");
    const pollApi = `${mediaBase}/tasks/batch/${encodeURIComponent(batchId)}${tokenParam}`;

    const cellsHtml = tasks.length
      ? tasks.map((task) => renderImageCell({
        task,
        mediaBase,
        tokenParam,
        generatedDir,
        cssRatio,
      })).join("")
      : `<div class="failed">Task not found</div>`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${codiaCss ? `<link rel="stylesheet" href="${escAttr(codiaCss)}">` : ""}
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:light}
html,body{width:100%;max-width:100%;overflow:auto}
body{background:var(--bg-card,#FCFAF5);padding:8px;font-family:var(--font-sans,system-ui,sans-serif);color:var(--text,#292522)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:8px;width:100%;max-width:100%}
.cell{min-width:0;max-width:100%}
.image-card{width:100%;max-width:100%;overflow:hidden;border:1px solid color-mix(in srgb,var(--border,#ddd) 78%,transparent);border-radius:12px;background:color-mix(in srgb,var(--bg,#fff) 92%,transparent);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.preview{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:${cssRatio};max-height:360px;border:0;background:linear-gradient(180deg,rgba(255,255,255,.65),rgba(255,255,255,.2));cursor:zoom-in;overflow:hidden}
.preview img{display:block;width:100%;height:100%;max-width:100%;max-height:360px;object-fit:contain}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:7px;border-top:1px solid color-mix(in srgb,var(--border,#ddd) 62%,transparent)}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent,#8A6F4D) 24%,var(--border,#ddd));background:color-mix(in srgb,var(--bg,#fff) 86%,transparent);color:var(--text,#292522);font:600 12px/1 var(--font-sans,system-ui,sans-serif);text-decoration:none;cursor:pointer}
.action:hover{background:color-mix(in srgb,var(--accent,#8A6F4D) 12%,var(--bg,#fff))}
.skeleton{aspect-ratio:${cssRatio};max-height:360px;background:linear-gradient(90deg,#f0ede8 25%,#e8e4de 50%,#f0ede8 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:12px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.failed{display:grid;gap:8px;padding:12px;color:#b23b32;font-size:12px;line-height:1.5}
.failed-message{overflow-wrap:anywhere}
.failed-actions{display:flex;justify-content:flex-end}
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
  var imageMime = ${JSON.stringify(IMAGE_MIME)};

  function extOf(file) {
    var match = String(file || '').match(/\\.([^.]+)$/);
    return match ? match[1].toLowerCase() : '';
  }
  function enc(value) { return encodeURIComponent(String(value || '')); }
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
      kind: 'image',
      ext: ext,
      mime: imageMime[ext] || 'image/png',
      url: mediaBase + '/media/' + enc(file) + tokenParam,
      downloadUrl: mediaBase + '/media/download/' + enc(file) + tokenParam
    };
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function createAction(label, href, name) {
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
    return action;
  }
  function appendImageCard(cell, payload) {
    clear(cell);
    var card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.media = JSON.stringify(payload);

    var preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'preview';
    preview.dataset.action = 'open';
    var img = document.createElement('img');
    img.src = payload.url;
    img.alt = 'generated image';
    img.loading = 'lazy';
    preview.appendChild(img);

    var actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(createAction('Open'));
    actions.appendChild(createAction('Save', payload.downloadUrl, payload.name));

    card.appendChild(preview);
    card.appendChild(actions);
    cell.appendChild(card);
  }
  function appendFailed(cell, message, taskId) {
    clear(cell);
    var failed = document.createElement('div');
    failed.className = 'failed';
    var messageNode = document.createElement('div');
    messageNode.className = 'failed-message';
    messageNode.textContent = message || 'Image generation failed';
    failed.appendChild(messageNode);
    if (taskId) {
      var actions = document.createElement('div');
      actions.className = 'failed-actions';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'action';
      retry.dataset.action = 'retry';
      retry.dataset.taskId = taskId;
      retry.textContent = 'Retry';
      actions.appendChild(retry);
      failed.appendChild(actions);
    }
    cell.appendChild(failed);
  }
  function appendSkeleton(cell) {
    clear(cell);
    var skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.setAttribute('aria-label', 'Generating image');
    cell.appendChild(skeleton);
  }
  function updateCell(cell, task) {
    if (task.status === 'done' && task.files && task.files.length) {
      appendImageCard(cell, payloadFor(task.files[0]));
    } else if (task.status === 'failed') {
      appendFailed(cell, task.failReason, task.taskId);
    } else {
      appendSkeleton(cell);
    }
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
        if (!cell) continue;
        if (cell.dataset.state === task.status) continue;
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
    parent.postMessage({
      type: 'resize-request',
      payload: { width: document.body.scrollWidth, height: document.body.scrollHeight }
    }, '*');
  }
  function openImage(card) {
    if (!card) return;
    try {
      parent.postMessage({ type: 'media-open-request', payload: JSON.parse(card.dataset.media || '{}') }, '*');
    } catch (e) {}
  }
  async function retryTask(button) {
    var taskId = button && button.dataset ? button.dataset.taskId : '';
    var cell = taskId ? findCell(taskId) : null;
    if (!taskId || !cell) return;
    button.disabled = true;
    button.textContent = 'Retrying...';
    try {
      var url = mediaBase + '/tasks/' + enc(taskId) + '/retry' + tokenParam;
      var res = await fetch(url, { method: 'POST', cache: 'no-store' });
      if (!res.ok) throw new Error('retry failed: http ' + res.status);
      appendSkeleton(cell);
      cell.dataset.state = 'pending';
      notifyResize();
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, 250);
    } catch (e) {
      appendFailed(cell, e && e.message ? e.message : 'Retry failed', taskId);
      cell.dataset.state = 'failed';
      notifyResize();
    }
  }
  document.addEventListener('click', function(event) {
    var target = event.target;
    var retry = target && target.closest ? target.closest('[data-action="retry"]') : null;
    if (retry) {
      event.preventDefault();
      retryTask(retry);
      return;
    }
    var opener = target && target.closest ? target.closest('[data-action="open"]') : null;
    if (!opener) return;
    event.preventDefault();
    openImage(opener.closest('.image-card'));
  });
  function initialReady() {
    notifyResize();
    parent.postMessage({ type: 'ready' }, '*');
  }
  requestAnimationFrame(initialReady);
  new ResizeObserver(notifyResize).observe(document.body);
  if (hasPending) timer = setTimeout(poll, POLL_MS);
})();
</script>
</body></html>`;

    return c.html(html);
  });
}

function renderImageCell({ task, mediaBase, tokenParam, generatedDir }) {
  const state = task.status || "pending";
  return `<div class="cell" data-task-id="${escAttr(task.taskId)}" data-state="${escAttr(state)}">${renderImageCellInner({
    task,
    mediaBase,
    tokenParam,
    generatedDir,
  })}</div>`;
}

function renderImageCellInner({ task, mediaBase, tokenParam, generatedDir }) {
  if (task.status === "done" && task.files?.length) {
    const payload = imagePayload(task.files[0], mediaBase, tokenParam, generatedDir);
    if (!payload) return `<div class="failed">Unsupported image output</div>`;
    return renderImageCard(payload);
  }
  if (task.status === "failed") {
    return `<div class="failed"><div class="failed-message">${esc(task.failReason || "Image generation failed")}</div><div class="failed-actions"><button class="action" type="button" data-action="retry" data-task-id="${escAttr(task.taskId)}">Retry</button></div></div>`;
  }
  return `<div class="skeleton" aria-label="Generating image"></div>`;
}

function imagePayload(file, mediaBase, tokenParam, generatedDir) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  return {
    fileName: file,
    name: file,
    path: path.join(generatedDir, file),
    kind: "image",
    ext,
    mime: IMAGE_MIME[ext] || "image/png",
    url: `${mediaBase}/media/${encodeURIComponent(file)}${tokenParam}`,
    downloadUrl: `${mediaBase}/media/download/${encodeURIComponent(file)}${tokenParam}`,
  };
}

function renderImageCard(payload) {
  return `<div class="image-card" data-media="${escAttr(JSON.stringify(payload))}">`
    + `<button class="preview" type="button" data-action="open">`
    + `<img src="${escAttr(payload.url)}" alt="generated image" loading="lazy">`
    + `</button>`
    + `<div class="actions">`
    + `<button class="action" type="button" data-action="open">Open</button>`
    + `<a class="action" href="${escAttr(payload.downloadUrl)}" download="${escAttr(payload.name)}">Save</a>`
    + `</div></div>`;
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return esc(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
