type EvidenceOptions = {
  canvas: HTMLCanvasElement;
  available: () => boolean;
  render: (time?: number) => void;
  suspend: () => () => boolean;
  cycleSeconds: number;
};

/** Local canvas evidence only; never requests camera, microphone or display access. */
export function createEvidenceControls(options: EvidenceOptions) {
  const png = document.getElementById('save-png') as HTMLButtonElement;
  const video = document.getElementById('record-webm') as HTMLButtonElement;
  const status = document.getElementById('evidence-status')!;
  const download = document.getElementById('evidence-download') as HTMLAnchorElement;
  const savedPath = document.getElementById('evidence-path')!;
  const retry = document.getElementById('retry-evidence') as HTMLButtonElement;
  const machineState = document.getElementById('evidence-state')!;
  const seconds = options.cycleSeconds * 2;
  let imagePending = false;
  let saving = false;
  let pending: { blob: Blob; metadata: Record<string, unknown> } | null = null;
  let disposed = false;
  let capture: { stop: (reason?: string) => void; finishing: boolean } | null = null;

  function report(state: string, message: string, extra: Record<string, unknown> = {}) {
    status.textContent = message;
    status.dataset.state = state;
    machineState.textContent = JSON.stringify({ state, message, ...extra });
  }
  function configure() {
    png.disabled = disposed || !options.available() || imagePending || saving || !!capture;
    video.disabled = disposed || !options.available() || imagePending || saving || !!capture?.finishing;
    retry.disabled = disposed || saving || !!capture;
    video.textContent = capture ? capture.finishing ? '正在结束录制…' : '取消录制' : '录制两轮 WebM · 20 秒';
  }
  async function persist(blob: Blob, metadata: Record<string, unknown>) {
    pending = { blob, metadata };
    saving = true;
    download.hidden = true;
    savedPath.textContent = '';
    retry.hidden = true;
    configure();
    report('saving-local', '画布成果已生成，正在保存到本机预览目录…', metadata);
    try {
      const response = await fetch('/evidence', { method: 'POST', body: blob,
        headers: { 'Content-Type': blob.type, 'X-Codia-Evidence': JSON.stringify({
          ...metadata, source: 'preview-canvas', completed: true,
        }) },
      });
      const result = await response.json();
      if (!response.ok || result.saved !== true) throw new Error(result.error || `本地保存失败 (${response.status})`);
      const url = new URL(result.downloadUrl, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/evidence/')) throw new Error('本地保存返回了无效下载地址。');
      download.href = url.href;
      download.download = result.filename;
      download.textContent = `下载 ${result.filename}`;
      download.hidden = false;
      savedPath.textContent = result.localPath;
      pending = null;
      report('saved-local', `${metadata.format === 'webm' ? '两轮录像已保存到本机，原播放状态已恢复' : 'PNG 已保存到本机'}。可点击下方链接下载。`, {
        ...metadata, filename: result.filename, bytes: result.bytes, mimeType: result.mimeType,
        localPath: result.localPath, metadataPath: result.metadataPath, downloadUrl: url.href, sha256: result.sha256,
      });
    } catch (error) {
      retry.hidden = false;
      report('error', `本地保存未确认：${error instanceof Error ? error.message : String(error)}。可重试保存当前成果。`, metadata);
    } finally { saving = false; configure(); }
  }
  async function savePng() {
    if (!options.available() || capture || imagePending || saving || disposed) return;
    imagePending = true;
    configure();
    report('encoding-png', '正在生成当前画布 PNG…');
    try {
      // toBlob snapshots synchronously before WebGL discards its drawing buffer.
      options.render();
      const metadata = { format: 'png', width: options.canvas.width, height: options.canvas.height,
        time: Number(options.canvas.dataset.time) };
      const blob = await new Promise<Blob>((resolve, reject) => options.canvas.toBlob(
        value => value ? resolve(value) : reject(new Error('画布 PNG 编码失败。')), 'image/png'));
      if (disposed) return;
      await persist(blob, metadata);
    } catch (error) {
      report('error', `PNG 导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { imagePending = false; configure(); }
  }
  function record() {
    if (capture) { capture.stop('已取消录制，未导出不完整视频。'); return; }
    if (!options.available() || imagePending || saving || disposed) return;
    if (document.hidden) { report('error', '请保持预览页面可见后再开始录制。'); return; }
    if (typeof MediaRecorder === 'undefined' || typeof options.canvas.captureStream !== 'function') {
      report('error', '当前浏览器不支持本地画布 WebM 录制。'); return;
    }
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { report('error', '当前浏览器没有可用的 WebM 编码器。'); return; }
    let stream: MediaStream;
    let recorder: MediaRecorder;
    try {
      stream = options.canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      report('error', `无法开始录制：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const savedControls = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.panel button, .panel input'))
      .filter(control => control !== video).map(control => ({ control, disabled: control.disabled }));
    const restore = options.suspend();
    const chunks: Blob[] = [];
    const dimensions = { width: options.canvas.width, height: options.canvas.height };
    let animation = 0;
    let start = 0;
    let elapsed = 0;
    let failure = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(animation);
      stream.getTracks().forEach(track => track.stop());
      capture = null;
      try {
        const canRestore = restore();
        if (canRestore) savedControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      } catch (error) {
        savedControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
        failure = `恢复预览绘制失败：${error instanceof Error ? error.message : String(error)}`;
      }
      configure();
      if (disposed) return;
      if (failure || elapsed < seconds || !chunks.some(chunk => chunk.size)) {
        report('error', failure || '录制未完成两轮或没有产生视频数据，未导出。', { elapsedSeconds: elapsed });
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      void persist(blob, {
        format: 'webm', cycles: 2, startTime: 0, timelineSeconds: seconds,
        elapsedSeconds: elapsed, ...dimensions,
      });
    };
    const stop = (reason?: string) => {
      if (finished || capture?.finishing) return;
      failure = reason ?? '';
      cancelAnimationFrame(animation);
      if (capture) capture.finishing = true;
      configure();
      if (recorder.state !== 'inactive') recorder.stop();
      else finish();
    };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = finish;
    recorder.onerror = event => stop(`录制失败：${(event as Event & { error?: DOMException }).error?.message ?? '编码器错误'}`);
    capture = { stop, finishing: false };
    savedControls.forEach(({ control }) => { control.disabled = true; });
    configure();
    const tick = (now: number) => {
      if (finished || capture?.finishing) return;
      elapsed = (now - start) / 1000;
      try {
        options.render(Math.min(elapsed, seconds) % options.cycleSeconds);
      } catch (error) { stop(`模型绘制失败：${error instanceof Error ? error.message : String(error)}`); return; }
      report('recording', `正在录制 ${Math.min(elapsed, seconds).toFixed(1)} / ${seconds} 秒 · 两轮循环`, {
        elapsedSeconds: Math.min(elapsed, seconds), timelineSeconds: seconds, cycles: 2, startTime: 0,
      });
      if (elapsed >= seconds) stop();
      else animation = requestAnimationFrame(tick);
    };
    try {
      recorder.start(250);
      start = performance.now();
      options.render(0);
      report('recording', `正在录制 0.0 / ${seconds} 秒 · 两轮循环`, { startTime: 0, timelineSeconds: seconds, cycles: 2 });
      animation = requestAnimationFrame(tick);
    } catch (error) { stop(`无法开始录制：${error instanceof Error ? error.message : String(error)}`); }
  }
  const visibilityChanged = () => {
    if (document.hidden) capture?.stop('页面进入后台，录制已中止；请保持页面可见后重试。');
  };
  png.addEventListener('click', savePng);
  video.addEventListener('click', record);
  const retrySave = () => { if (pending && !saving && !capture && !disposed) void persist(pending.blob, pending.metadata); };
  retry.addEventListener('click', retrySave);
  document.addEventListener('visibilitychange', visibilityChanged);
  return {
    get recording() { return !!capture; },
    configure,
    abort: (reason: string) => capture?.stop(reason),
    dispose() {
      disposed = true;
      capture?.stop('预览已关闭，录制中止。');
      png.removeEventListener('click', savePng);
      video.removeEventListener('click', record);
      retry.removeEventListener('click', retrySave);
      document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}
