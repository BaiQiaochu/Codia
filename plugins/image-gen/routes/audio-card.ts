/**
 * image-gen/routes/audio-card.js
 *
 * Audio/music card route kept separate from image and video rendering.
 */
import path from "node:path";

const AUDIO_MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

const AUDIO_EXTS = new Set(Object.keys(AUDIO_MIME));

export default function (app, ctx) {
  app.get("/audio-card", (c) => {
    const batchId = c.req.query("batch");
    if (!batchId) return c.text("Missing batch parameter", 400);

    const store = ctx._mediaGen?.store;
    const tasks = store?.getByBatch(batchId) || [];
    const token = c.req.query("token") || "";
    const mediaBase = `/api/plugins/${ctx.pluginId}`;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const codiaCss = c.req.query("codia-css") || "";
    const hasPending = tasks.some((t) => t.status === "pending");
    const generatedDir = path.join(ctx.dataDir, "generated");
    const pollApi = `${mediaBase}/tasks/batch/${encodeURIComponent(batchId)}${tokenParam}`;

    const cellsHtml = tasks.length
      ? tasks.map((task) => renderAudioCell({ task, mediaBase, tokenParam, generatedDir })).join("")
      : `<div class="failed">Task not found</div>`;

    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
${codiaCss ? `<link rel="stylesheet" href="${escAttr(codiaCss)}">` : ""}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg-card,#FCFAF5);padding:8px;font-family:var(--font-sans,system-ui,sans-serif);color:var(--text,#292522)}
.grid{display:grid;gap:8px;width:100%;max-width:100%}
.audio-card{width:100%;overflow:hidden;border:1px solid color-mix(in srgb,var(--border,#ddd) 78%,transparent);border-radius:12px;background:color-mix(in srgb,var(--bg,#fff) 92%,transparent);box-shadow:0 4px 14px rgba(0,0,0,.07)}
.preview{padding:16px;min-height:92px;display:flex;align-items:center}
.preview audio{width:100%}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:7px;border-top:1px solid color-mix(in srgb,var(--border,#ddd) 62%,transparent)}
.action{display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:0 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent,#8A6F4D) 24%,var(--border,#ddd));background:color-mix(in srgb,var(--bg,#fff) 86%,transparent);color:var(--text,#292522);font:600 12px/1 var(--font-sans,system-ui,sans-serif);text-decoration:none;cursor:pointer}
.skeleton{min-height:92px;background:linear-gradient(90deg,#f0ede8 25%,#e8e4de 50%,#f0ede8 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:12px}
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
  var audioMime = ${JSON.stringify(AUDIO_MIME)};

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
      kind: 'audio',
      ext: ext,
      mime: audioMime[ext] || 'audio/mpeg',
      url: mediaBase + '/media/' + enc(file) + tokenParam,
      downloadUrl: mediaBase + '/media/download/' + enc(file) + tokenParam
    };
  }
  function clear(node){ while (node.firstChild) node.removeChild(node.firstChild); }
  function appendAudioCard(cell, payload) {
    clear(cell);
    var card = document.createElement('div');
    card.className = 'audio-card';
    card.dataset.media = JSON.stringify(payload);
    var preview = document.createElement('div');
    preview.className = 'preview';
    var audio = document.createElement('audio');
    audio.src = payload.url;
    audio.controls = true;
    audio.preload = 'metadata';
    preview.appendChild(audio);
    var actions = document.createElement('div');
    actions.className = 'actions';
    var open = document.createElement('button');
    open.className = 'action';
    open.type = 'button';
    open.dataset.action = 'open';
    open.textContent = 'Open';
    var save = document.createElement('a');
    save.className = 'action';
    save.href = payload.downloadUrl;
    save.download = payload.name;
    save.textContent = 'Save';
    actions.appendChild(open);
    actions.appendChild(save);
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
    if (task.status === 'done' && task.files && task.files.length) appendAudioCard(cell, payloadFor(task.files[0]));
    else if (task.status === 'failed') appendText(cell, 'failed', task.failReason || 'Audio generation failed');
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
  function openAudio(card) {
    if (!card) return;
    try { parent.postMessage({ type: 'media-open-request', payload: JSON.parse(card.dataset.media || '{}') }, '*'); } catch (e) {}
  }
  document.addEventListener('click', function(event) {
    var target = event.target;
    var opener = target && target.closest ? target.closest('[data-action="open"]') : null;
    if (!opener) return;
    event.preventDefault();
    openAudio(opener.closest('.audio-card'));
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

function renderAudioCell({ task, mediaBase, tokenParam, generatedDir }) {
  const state = task.status || "pending";
  return `<div class="cell" data-task-id="${escAttr(task.taskId)}" data-state="${escAttr(state)}">${renderAudioCellInner({
    task,
    mediaBase,
    tokenParam,
    generatedDir,
  })}</div>`;
}

function renderAudioCellInner({ task, mediaBase, tokenParam, generatedDir }) {
  if (task.status === "done" && task.files?.length) {
    const payload = audioPayload(task.files[0], mediaBase, tokenParam, generatedDir);
    if (!payload) return `<div class="failed">Unsupported audio output</div>`;
    return renderAudioCard(payload);
  }
  if (task.status === "failed") return `<div class="failed">${esc(task.failReason || "Audio generation failed")}</div>`;
  return `<div class="skeleton" aria-label="Generating audio"></div>`;
}

function audioPayload(file, mediaBase, tokenParam, generatedDir) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return null;
  return {
    fileName: file,
    name: file,
    path: path.join(generatedDir, file),
    kind: "audio",
    ext,
    mime: AUDIO_MIME[ext] || "audio/mpeg",
    url: `${mediaBase}/media/${encodeURIComponent(file)}${tokenParam}`,
    downloadUrl: `${mediaBase}/media/download/${encodeURIComponent(file)}${tokenParam}`,
  };
}

function renderAudioCard(payload) {
  return `<div class="audio-card" data-media="${escAttr(JSON.stringify(payload))}">`
    + `<div class="preview"><audio src="${escAttr(payload.url)}" controls preload="metadata"></audio></div>`
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
