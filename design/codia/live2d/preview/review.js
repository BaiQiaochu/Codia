const byId = id => document.getElementById(id);
const video = byId('review-video');
const times = [0, 1.38, 2.42, 3.4, 4.4, 5.4, 6.4, 8.55, 10, 13.4, 14.4, 18.55, 20];
const defaultFile = 'codia-20261006T145404231Z-0295a8ee-92ee-4296-bb17-619981c6c155.webm';
const filename = new URL(location.href).searchParams.get('file') || defaultFile;
const errors = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
const events = [];
let requestedSeek = null;
let presentedFrameTime = null;
let callback = 0;
let stopped = false;
const number = value => Number.isFinite(value) ? value : String(value);
const ranges = value => Array.from({ length: value.length }, (_, index) => [value.start(index), value.end(index)]);

function message(text, error = false) {
  byId('review-status').textContent = text;
  byId('review-status').dataset.error = String(error);
}
function snapshot() {
  const quality = video.getVideoPlaybackQuality?.();
  const state = {
    state: video.error ? 'error' : video.seeking ? 'seeking' : video.readyState < 2 ? 'loading' : video.paused ? 'paused' : 'playing',
    currentSrc: video.currentSrc, currentTime: video.currentTime, duration: number(video.duration),
    presentedFrameTime, requestedSeek, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
    readyState: video.readyState, networkState: video.networkState,
    paused: video.paused, seeking: video.seeking, ended: video.ended,
    seekable: ranges(video.seekable), buffered: ranges(video.buffered),
    canPlayVP9: video.canPlayType('video/webm;codecs=vp9'),
    playbackQuality: quality ? { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames, corruptedVideoFrames: quality.corruptedVideoFrames } : null,
    error: video.error ? { code: video.error.code, name: errors[video.error.code], message: video.error.message } : null,
  };
  byId('review-metadata').textContent = JSON.stringify(state, null, 2);
  byId('review-state').textContent = JSON.stringify(state);
  for (const button of document.querySelectorAll('button')) button.disabled = video.readyState < 1 || !!video.error;
}
function log(type, detail = '') {
  events.push(`${new Date().toLocaleTimeString()} ${type} @ ${video.currentTime.toFixed(4)}s${detail ? ` · ${detail}` : ''}`);
  if (events.length > 32) events.shift();
  byId('review-events').textContent = events.join('\n');
}
function seek(time) {
  video.pause();
  requestedSeek = time;
  const target = Number.isFinite(video.duration) ? Math.min(time, Math.max(0, video.duration - 0.001)) : time;
  try {
    video.currentTime = target;
    message(`请求 ${time.toFixed(2)} 秒${target !== time ? `，按实际时长限制到 ${target.toFixed(4)} 秒` : ''}；等待解码。`);
    log('seek-request', `${time} → ${target}`);
    snapshot();
  } catch (error) { message(`跳转失败：${error.message}`, true); log('seek-error', error.message); }
}
async function play(restart = false) {
  if (restart) { requestedSeek = 0; video.currentTime = 0; }
  try { await video.play(); message('正在播放已保存的真实录像。'); }
  catch (error) { message(`播放失败：${error.message}`, true); log('play-error', error.message); }
}
for (const time of times) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${time} 秒`;
  button.dataset.seek = String(time);
  button.disabled = true;
  button.addEventListener('click', () => seek(time));
  byId('seek-buttons').append(button);
}
byId('review-play').addEventListener('click', () => play());
byId('review-pause').addEventListener('click', () => { video.pause(); snapshot(); });
byId('review-restart').addEventListener('click', () => play(true));
for (const event of ['loadedmetadata', 'loadeddata', 'durationchange', 'canplay', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'ended', 'error']) {
  video.addEventListener(event, () => {
    log(event, video.error?.message || '');
    if (video.error) message(`解码/加载错误：${errors[video.error.code]} · ${video.error.message}`, true);
    else if (event === 'loadeddata') message('已解码首帧，可播放完整录像或选择时间点。');
    else if (event === 'seeked') message(`已跳转：浏览器 currentTime ${video.currentTime.toFixed(4)} 秒；核对呈现帧时间。`);
    else if (event === 'ended') message(`真实录像已播放结束，浏览器时长 ${number(video.duration)} 秒。`);
    snapshot();
  });
}
video.addEventListener('timeupdate', snapshot);
video.addEventListener('progress', snapshot);
if ('requestVideoFrameCallback' in video) {
  const presented = (_now, metadata) => {
    presentedFrameTime = metadata.mediaTime;
    snapshot();
    if (!stopped) callback = video.requestVideoFrameCallback(presented);
  };
  callback = video.requestVideoFrameCallback(presented);
}
window.addEventListener('pagehide', () => { stopped = true; if (callback) video.cancelVideoFrameCallback(callback); video.pause(); }, { once: true });
if (!/^codia-\d{8}T\d{9}Z-[a-f0-9-]{36}\.webm$/.test(filename)) {
  message('文件名无效，仅支持本机预览生成的 WebM。', true);
} else {
  byId('filename').textContent = filename;
  video.src = `/evidence/${filename}`;
  byId('review-download').href = video.src;
  byId('review-download').download = filename;
  fetch(`/evidence/${filename.replace(/\.webm$/, '.json')}`, { cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .then(metadata => { byId('capture-metadata').textContent = JSON.stringify(metadata, null, 2); })
    .catch(error => { byId('capture-metadata').textContent = `证据记录读取失败：${error.message}`; });
}
