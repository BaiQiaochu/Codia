import { CubismFramework, LogLevel, Option } from '@cubism/live2dcubismframework';
import { CubismModelSettingJson } from '@cubism/cubismmodelsettingjson';
import { CubismUserModel } from '@cubism/model/cubismusermodel';
import { CubismMatrix44 } from '@cubism/math/cubismmatrix44';
import { CubismShaderManager_WebGL } from '@cubism/rendering/cubismshader_webgl';
import { CubismWebGLOffscreenManager } from '@cubism/rendering/cubismoffscreenmanager';
import { describePhase, duration, parameterIds, coreParameterIds, extraParameterIds, sampleTimeline } from './timeline';
import { coreBindingStatus, bindingStatusText, bindingSummaryText } from './binding-status';
import { emptyValidation, validateBindings, type BindingValidation } from './validate-bindings';
import { manualPose, modelToViewport, viewportToModel, type Point } from './debug';
import { createEvidenceControls } from './evidence';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('canvas');
const play = element<HTMLButtonElement>('play');
const reload = element<HTMLButtonElement>('reload');
const scrub = element<HTMLInputElement>('scrub');
const reduce = element<HTMLInputElement>('reduce');
const media = matchMedia('(prefers-reduced-motion: reduce)');
reduce.checked = media.matches;
let userModel: CubismUserModel | null = null;
let gl: WebGL2RenderingContext | null = null;
let textures: WebGLTexture[] = [];
let parameters = new Map<string, number>();
let missing: string[] = [];
let activeRequest: AbortController | null = null;
let clock = 0;
let lastFrame = 0;
let frame = 0;
let paused = false;
let inView = true;
let destroyed = false;
let loading = false;
let manualValues: Map<string, number> | null = null;
let marking: 'left' | 'right' | null = null;
let contactPoints: Partial<Record<'left' | 'right', Point>> = {};
const debugInputs = new Map<string, { input: HTMLInputElement; output: HTMLOutputElement; detail: HTMLElement }>();
const actionNames: Record<string, string> = {
  ParamBodyRise: '身体升降',
  ParamHandLReach: '角色左手伸出（画面右）', ParamHandRReach: '角色右手伸出（画面左）',
  ParamHandLGrip: '角色左手局部握持', ParamHandRGrip: '角色右手局部握持',
  ParamAngleX: '头部左右转向', ParamAngleY: '头部上下抬头',
  ParamEyeBallX: '双眼水平视线', ParamEyeBallY: '双眼上下视线',
  ParamAngleZ: '头部侧倾', ParamEyeLOpen: '角色左眼眨眼',
  ParamEyeROpen: '角色右眼眨眼', ParamHairSwing: '头发摆动',
};

function prepareDebugControls() {
  for (const id of parameterIds) {
    const row = document.createElement('div');
    row.className = 'parameter-control';
    const label = document.createElement('label');
    label.htmlFor = `debug-${id}`;
    label.textContent = id;
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.id = `debug-${id}`;
    input.type = 'range';
    input.disabled = true;
    const detail = document.createElement('small');
    detail.textContent = '未载入模型';
    row.append(label, output, input, detail);
    element('manual-parameters').append(row);
    debugInputs.set(id, { input, output, detail });
    input.addEventListener('input', () => {
      if (!userModel || !parameters.has(id)) return;
      manualValues ??= manualPose(userModel.getModel());
      manualValues.set(id, Number(input.value));
      paused = true;
      updatePlayback();
    });
  }
}
function configureDebugControls() {
  for (const [id, control] of debugInputs) {
    const index = parameters.get(id);
    control.input.disabled = !userModel || index === undefined;
    control.output.textContent = '';
    control.detail.textContent = !userModel ? '未载入模型' : index === undefined ? '参数缺失，无法调节' : '';
    if (!userModel || index === undefined) continue;
    const model = userModel.getModel();
    const min = model.getParameterMinimumValue(index);
    const max = model.getParameterMaximumValue(index);
    control.input.min = String(min);
    control.input.max = String(max);
    control.input.step = String((max - min) / 1000 || 0.001);
    control.input.value = String(model.getParameterValueByIndex(index));
    control.detail.textContent = `范围 ${min}…${max}；默认 ${model.getParameterDefaultValue(index)}`;
  }
  for (const id of ['manual-defaults', 'manual-raised', 'mark-left', 'mark-right', 'clear-contacts']) {
    element<HTMLButtonElement>(id).disabled = !userModel;
  }
}
function setManualPose(raised: boolean) {
  if (!userModel) return;
  manualValues = manualPose(userModel.getModel(), true, raised ? sampleTimeline(0, true) : {});
  paused = true;
  updatePlayback();
}
function updateDebugState() {
  const matrix = userModel?.getModelMatrix().getArray();
  for (const side of ['left', 'right'] as const) {
    const marker = document.getElementById(`contact-${side}`)!;
    const point = contactPoints[side];
    marker.setAttribute('visibility', point && matrix ? 'visible' : 'hidden');
    if (point && matrix) {
      const projected = modelToViewport(point, matrix);
      marker.setAttribute('transform', `translate(${projected.x * 1000} ${projected.y * 1000})`);
    }
  }
  element('contact-status').textContent = marking
    ? `在模型画面上点击${marking === 'left' ? '角色左手（画面右侧）' : '角色右手（画面左侧）'}应抓住的固定框沿位置。`
    : '十字为手动标记的固定目标，不跟随手部变形。可先摆好双手，再标记，单独调身体检查接触点是否漂移。';
  canvas.classList.toggle('marking-contact', marking !== null);
  const info = userModel?.getModel().getModel().canvasinfo;
  const model = userModel?.getModel();
  element('debug-state').textContent = JSON.stringify({
    state: userModel ? manualValues ? 'manual' : 'timeline' : 'not-loaded',
    paused, time: clock,
    parameters: manualValues ? Object.fromEntries(manualValues) : null,
    contacts: contactPoints,
    contactCoordinateSpace: 'model-space-fixed-targets',
    canvasInfo: info ? {
      width: info.CanvasWidth, height: info.CanvasHeight,
      originX: info.CanvasOriginX, originY: info.CanvasOriginY, pixelsPerUnit: info.PixelsPerUnit,
    } : null,
    modelMatrix: matrix ? Array.from(matrix) : null,
    rendering: {
      context: gl ? 'webgl2' : null,
      frameworkSdk: '5-r.5',
      coreVersion: model ? Live2DCubismCore.Version.csmGetVersion() : null,
      latestMocVersion: model ? Live2DCubismCore.Version.csmGetLatestMocVersion() : null,
      offscreenGroups: model ? Array.from({ length: model.getOffscreenCount() }, (_, index) => ({
        owner: model.getPartId(model.getOffscreenOwnerIndices()[index]).getString(),
        opacity: model.getOffscreenOpacity(index),
        masks: Array.from(model.getOffscreenMasks()[index] ?? [])
          .slice(0, model.getOffscreenMaskCounts()[index])
          .map(mask => model.getDrawableId(mask).getString()),
      })) : [],
    },
  }, null, 2);
}

function publishValidation(report: BindingValidation) {
  // A non-executable JSON element is readable by local smoke checks without
  // exposing mutable Cubism instances or requiring the animation to run.
  element('binding-validation').textContent = JSON.stringify({ ...report, coreSummary: coreBindingStatus(report) }, null, 2);
  canvas.dataset.bindingValidation = report.state;
  for (const [target, ids] of [['core-actions', coreParameterIds], ['extra-actions', extraParameterIds]] as const) {
    element(target).replaceChildren(...ids.map(id => {
      const row = document.createElement('li');
      const response = report.parameters.find(item => item.id === id)?.status;
      const label = report.state !== 'checked' ? '待采样' : response === 'responsive' ? '绑定有响应'
        : response === 'no-change-detected' ? '未检测到绑定响应' : '参数缺失';
      row.textContent = `${actionNames[id]} · ${label}`;
      return row;
    }));
  }
  if (report.state !== 'checked') {
    element('binding-summary').textContent = report.state === 'checking' ? '正在采样实际模型的参数响应…' : '尚未验证参数响应。';
    element('binding-results').textContent = report.error ?? '';
    return;
  }
  element('binding-summary').textContent = bindingSummaryText(report);
  element('binding-results').textContent = report.parameters.map(item => {
    const label = `${item.id}${(extraParameterIds as readonly string[]).includes(item.id) ? '（扩展调试，不自动播放）' : '（核心动作）'}`;
    if (item.status === 'missing') return `${label}：缺失`;
    if (item.status === 'no-change-detected') return `${label}：存在，但未检测到网格或离屏组变化`;
    return `${label}：存在且会改变模型（${item.changedDrawables.length} 个网格、${item.changedOffscreens?.length ?? 0} 个离屏组；${item.changes.join(', ')}）`;
  }).join('\n');
}

function message(title: string, detail: string) {
  element('waiting').hidden = false;
  element('waiting-title').textContent = title;
  element('waiting-detail').textContent = detail;
  element('status').textContent = title;
}
function discardModel() {
  evidence.abort('模型已卸载或绘制中断，未导出不完整录像。');
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
  userModel?.release();
  userModel = null;
  // Renderer.release destroys FBOs; evict this context's cached containers too.
  if (gl) CubismWebGLOffscreenManager.getInstance().removeContext(gl);
  evidence.configure();
  for (const texture of textures) gl?.deleteTexture(texture);
  textures = [];
  parameters.clear();
  missing = [];
  manualValues = null;
  contactPoints = {};
  marking = null;
  configureDebugControls();
  updateDebugState();
  play.disabled = true;
  scrub.disabled = true;
  element('parameters').textContent = '未载入模型';
  element('missing').textContent = '';
  delete canvas.dataset.modelLoaded;
  delete canvas.dataset.missingParameters;
  publishValidation(emptyValidation());
  if (gl && !gl.isContextLost()) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
}
async function fetchBuffer(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`资源加载失败 (${response.status}): ${new URL(url, location.href).pathname}`);
  return response.arrayBuffer();
}
function localAsset(reference: string, modelUrl: string): string {
  const url = new URL(reference, modelUrl);
  if (url.origin !== location.origin || !url.pathname.startsWith('/model/')) {
    throw new Error('模型资源必须位于指定的本地模型目录。');
  }
  return url.href;
}
async function addTexture(url: string, signal: AbortSignal): Promise<WebGLTexture> {
  const buffer = await fetchBuffer(url, signal);
  const image = await createImageBitmap(new Blob([buffer]), { premultiplyAlpha: 'premultiply' });
  try {
    signal.throwIfAborted();
    const texture = gl!.createTexture();
    if (!texture) throw new Error('无法创建模型纹理。');
    textures.push(texture);
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR_MIPMAP_LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, image);
    gl!.generateMipmap(gl!.TEXTURE_2D);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    return texture;
  } finally { image.close(); }
}
function resize() {
  // Keep the captured video dimensions fixed until the recording finishes.
  if (evidence.recording) return;
  const size = Math.max(1, Math.round(canvas.getBoundingClientRect().width * Math.min(devicePixelRatio, 2)));
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
    userModel?.setRenderTargetSize(size, size);
  }
  draw();
}
function draw() {
  if (!userModel || !gl || gl.isContextLost() || destroyed) return;
  const model = userModel.getModel();
  const values = manualValues ? Object.fromEntries(manualValues) : sampleTimeline(clock, evidence.recording ? false : reduce.checked);
  // Check the actual exported parameter list: Cubism otherwise invents absent IDs.
  model.loadParameters();
  for (const [name, value] of Object.entries(values)) {
    const index = parameters.get(name);
    if (index !== undefined) model.setParameterValueByIndex(index, value);
  }
  model.update();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const matrix = new CubismMatrix44();
  matrix.multiplyByMatrix(userModel.getModelMatrix());
  const renderer = userModel.getRenderer();
  renderer.setMvpMatrix(matrix);
  renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
  const offscreen = CubismWebGLOffscreenManager.getInstance();
  offscreen.beginFrameProcess(gl);
  try { renderer.drawModel('/shaders/'); }
  finally { offscreen.endFrameProcess(gl); }
  scrub.value = String(clock);
  element('time').textContent = `${clock.toFixed(2)} / 10.00 秒`;
  element('phase').textContent = manualValues ? '手动参数检查 · 自动循环已停止' : reduce.checked && !evidence.recording ? '静止展示 · 双手抓框、正视前方' : describePhase(clock);
  element('parameters').textContent = Array.from(parameters, ([name, index]) =>
    `${name}: ${model.getParameterValueByIndex(index).toFixed(3)}`,
  ).join('\n');
  canvas.dataset.time = clock.toFixed(3);
  canvas.dataset.modelLoaded = 'true';
  canvas.dataset.missingParameters = missing.join(',');
  for (const [id, control] of debugInputs) {
    const index = parameters.get(id);
    if (index === undefined) continue;
    const value = model.getParameterValueByIndex(index);
    control.input.value = String(value);
    control.output.textContent = value.toFixed(3);
  }
  updateDebugState();
}
function updatePlayback() {
  cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
  if (evidence.recording) return;
  play.textContent = manualValues ? '恢复自动循环' : paused ? '播放' : '暂停';
  if (!userModel || loading || destroyed || manualValues || paused || reduce.checked || document.hidden || !inView) {
    if (!document.hidden && inView) draw();
    return;
  }
  const tick = (now: number) => {
    if (lastFrame) clock = (clock + Math.min((now - lastFrame) / 1000, 0.1)) % duration;
    lastFrame = now;
    try { draw(); } catch (error) {
      discardModel();
      message('模型绘制失败', error instanceof Error ? error.message : String(error));
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
async function load() {
  if (loading || destroyed || evidence.recording) return;
  loading = true;
  reload.disabled = true;
  discardModel();
  delete canvas.dataset.modelLoaded;
  activeRequest = new AbortController();
  const { signal } = activeRequest;
  let setting: CubismModelSettingJson | null = null;
  try {
    message('检查模型文件…', '只读取本地 Codia 导出模型。');
    const response = await fetch('/preview-config.json', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('无法读取本地预览配置。');
    const config = await response.json();
    if (!config.modelExists) {
      message('等待 Cubism 模型导出', '尚无 Codia.model3.json。导出 .moc3、纹理和 model3.json 后点击重新加载；此时尚未播放 Live2D 动画。');
      element('phase').textContent = '等待模型，尚未播放动画。';
      return;
    }
    // SDK 5-r.5 Offscreen drawing uses blitFramebuffer even for normal blending.
    // A WebGL 1 fallback would load the model but fail when drawing HeadGroup.
    gl ??= canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) throw new Error('本机 WebGL 2 不可用。Cubism 5.3 离屏绘制与分组裁剪需要 WebGL 2，请检查浏览器硬件加速。');
    if (!CubismFramework.isStarted()) {
      const option = new Option();
      option.loggingLevel = LogLevel.LogLevel_Warning;
      option.logFunction = (text) => console.info(text);
      if (!CubismFramework.startUp(option)) throw new Error('Cubism Core 初始化失败。');
    }
    if (!CubismFramework.isInitialized()) CubismFramework.initialize();
    const modelUrl = new URL(config.modelUrl, location.href).href;
    const json = await fetchBuffer(modelUrl, signal);
    const parsed = JSON.parse(new TextDecoder().decode(json));
    if (parsed.Version !== 3 || !parsed.FileReferences?.Moc || !parsed.FileReferences?.Textures?.length) {
      throw new Error('导出文件缺少 Version 3、Moc 或 Textures。');
    }
    setting = new CubismModelSettingJson(json, json.byteLength);
    const moc = await fetchBuffer(localAsset(setting.getModelFileName(), modelUrl), signal);
    userModel = new CubismUserModel();
    userModel.loadModel(moc, true);
    const model = userModel.getModel();
    if (!model) throw new Error('Cubism Core 拒绝加载该 .moc3，请重新从 Editor 导出。');
    const layout = new Map<string, number>();
    setting.getLayoutMap(layout);
    userModel.getModelMatrix().setupFromLayout(layout);
    userModel.createRenderer(canvas.width, canvas.height);
    const renderer = userModel.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    for (let index = 0; index < setting.getTextureCount(); index++) {
      const texture = await addTexture(localAsset(setting.getTextureFileName(index), modelUrl), signal);
      renderer.bindTexture(index, texture);
    }
    renderer.loadShaders('/shaders/');
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    const deadline = performance.now() + 20000;
    while (!shader._isShaderLoaded) {
      signal.throwIfAborted();
      if (performance.now() > deadline) throw new Error('Cubism WebGL 着色器加载超时。');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (let index = 0; index < model.getParameterCount(); index++) {
      parameters.set(model.getParameterId(index).getString(), index);
    }
    // Restore this baseline before every automatic frame, including after a
    // manual edit to a debug-only parameter. Do not preserve unbound overrides.
    model.saveParameters();
    missing = coreParameterIds.filter(name => !parameters.has(name));
    publishValidation(emptyValidation('checking'));
    const validation = validateBindings(model, parameterIds, sampleTimeline(0, true));
    publishValidation(validation);
    const { inactive } = coreBindingStatus(validation);
    element('missing').textContent = [
      missing.length ? `缺少核心动作参数（${missing.length} 项）：\n${missing.join('\n')}` : '',
      inactive.length ? `核心动作参数存在但未检测到变化（${inactive.length} 项），请检查 Editor 绑定：\n${inactive.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    element('status').textContent = bindingStatusText(validation);
    element('waiting').hidden = true;
    clock = 0;
    paused = false;
    play.disabled = false;
    scrub.disabled = false;
    configureDebugControls();
    resize();
  } catch (error) {
    discardModel();
    if (!destroyed && !signal.aborted) {
      publishValidation({ ...emptyValidation('error'), error: error instanceof Error ? error.message : String(error) });
      message('模型尚不能播放', error instanceof Error ? error.message : String(error));
      console.error(error);
    }
  } finally {
    setting?.release();
    loading = false;
    reload.disabled = false;
    evidence.configure();
    if (!destroyed) updatePlayback();
  }
}
function dispose() {
  if (destroyed) return;
  destroyed = true;
  evidence.dispose();
  activeRequest?.abort();
  discardModel();
  visibility.disconnect();
  sizeObserver.disconnect();
  media.removeEventListener('change', systemMotion);
  document.removeEventListener('visibilitychange', updatePlayback);
  if (CubismFramework.isInitialized()) CubismFramework.dispose();
  // Keep the Core log callback registered once per page. cleanUp + startUp
  // would allocate another WASM function-table slot in Core 6.0.1.
}
const visibility = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; updatePlayback(); });
visibility.observe(canvas);
const sizeObserver = new ResizeObserver(resize);
sizeObserver.observe(canvas);
const systemMotion = () => { reduce.checked = media.matches; updatePlayback(); };
media.addEventListener('change', systemMotion);
document.addEventListener('visibilitychange', updatePlayback);
play.addEventListener('click', () => {
  if (manualValues) { manualValues = null; paused = false; }
  else paused = !paused;
  updatePlayback();
});
reduce.addEventListener('change', updatePlayback);
scrub.addEventListener('input', () => { manualValues = null; clock = Math.min(Number(scrub.value), duration - 0.0001); paused = true; updatePlayback(); });
element('manual-defaults').addEventListener('click', () => setManualPose(false));
element('manual-raised').addEventListener('click', () => setManualPose(true));
for (const side of ['left', 'right'] as const) element(`mark-${side}`).addEventListener('click', () => {
  if (!userModel) return;
  manualValues ??= manualPose(userModel.getModel());
  paused = true;
  marking = side;
  updatePlayback();
});
element('clear-contacts').addEventListener('click', () => { contactPoints = {}; marking = null; updateDebugState(); });
canvas.addEventListener('click', (event) => {
  if (evidence.recording || !marking || !userModel) return;
  const rect = canvas.getBoundingClientRect();
  contactPoints[marking] = viewportToModel({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, userModel.getModelMatrix().getInvert().getArray());
  marking = null;
  updateDebugState();
});
reload.addEventListener('click', load);
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  discardModel();
  message('WebGL 上下文丢失', '恢复后点击重新加载。模型源文件未更改。');
});
canvas.addEventListener('webglcontextrestored', () => location.reload());
window.addEventListener('pagehide', dispose, { once: true });
const evidence = createEvidenceControls({
  canvas,
  available: () => !!userModel && !!gl && !gl.isContextLost() && !loading && !destroyed,
  cycleSeconds: duration,
  render(time) { if (time !== undefined) clock = time; draw(); },
  suspend() {
    const saved = { model: userModel, clock, paused, manualValues, marking, reduce: reduce.checked };
    cancelAnimationFrame(frame);
    frame = 0;
    manualValues = null;
    marking = null;
    paused = true;
    return () => {
      if (userModel !== saved.model || destroyed) return false;
      clock = saved.clock;
      paused = saved.paused;
      manualValues = saved.manualValues;
      marking = saved.marking;
      reduce.checked = saved.reduce;
      resize();
      updatePlayback();
      return true;
    };
  },
});
prepareDebugControls();
void load();
