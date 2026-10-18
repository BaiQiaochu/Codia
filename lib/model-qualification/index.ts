import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseModelRef } from '../../shared/model-ref.ts';
import { createRunBudget, inspectRunBudget, type RunBudget } from '../workflow/run-budget.ts';
import { buildQualificationCase, buildQualificationPayload, OUTPUT_TOKEN_CAP, unsupportedReason, validateQualificationResponse } from './cases.ts';
import { QualificationStore } from './store.ts';
import { CAPABILITIES, QUALIFICATION_SUITE_VERSION, QUALIFICATION_TTL_MS } from './types.ts';
import type { CapabilityResult, ModelCapability, QualificationBudget, QualificationInspection, QualificationReport } from './types.ts';
export * from './types.ts';

const NOTE = '手动固定能力探测，不执行任何工具。通过仅代表这些样例通过，不代表模板端到端验收或供应商账单硬上限。结果 24 小时有效，配置变化即失效。';
const suggestions: Record<string, string> = {
  unsupported_provider_api: '此 API 尚无经过验证的预算探测适配器，请选择已支持的协议。',
  native_schema_transport_unsupported: '当前探测器尚未支持此协议的原生 JSON Schema；不会以提示词 JSON 冒充原生结构化输出。',
  image_input_not_configured: '请配置实际支持图像输入的模型及传输协议。',
  media_pricing_unverified: '此固定小图需要显式确认按输入 token 估算媒体费用；未知媒体费用不会按免费处理。',
  tools_disabled: '当前模型配置禁用了工具调用，请确认供应商能力后再修改配置。',
  text_contract_failed: '模型没有按固定文本契约回复；检查模型、推理预算与兼容配置。',
  tool_contract_failed: '模型没有返回有效工具调用及参数；检查工具调用协议和模型支持。',
  vision_contract_failed: '模型未正确识别测试图片；检查图像输入和传输兼容性。',
  schema_contract_failed: '模型输出未通过严格结构校验；检查原生 JSON Schema 支持。',
  budget_blocked: '预算无法预留下一次调用，或用量不完整；查看预算结果后再手动重试。',
  provider_failed: '供应商请求失败；检查认证、限流和端点配置后手动重试。',
  provider_auth_failed: '供应商拒绝认证；检查当前供应商配置，凭据不会出现在报告中。',
  provider_rate_limited: '供应商限流；稍后手动重试。',
  request_aborted: '探测已取消或超时；未知消耗保留预留，后续探测未派发。',
  provider_payload_unobserved: '适配器没有经过可验证的请求钩子，无法确认实际发送的探测约束。',
  response_model_mismatch: '返回模型身份与配置不一致，不能为当前模型生成资格。',
  configuration_changed: '探测期间模型或供应商配置发生变化；请按新配置重新探测。',
};
function result(capability: ModelCapability, status: CapabilityResult['status'], code: string): CapabilityResult {
  return { capability, status, code, suggestion: suggestions[code] || (status === 'pass' ? '固定样例已通过。' : '请检查供应商能力和配置后手动重试。'), requestId: null, responseDigest: null, durationMs: 0 };
}
function stable(value: any): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => typeof value[key] !== 'function').map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: any) => createHash('sha256').update(stable(value)).digest('hex');

export function resolveQualificationModel(engine: any, modelRef?: unknown) {
  const ref = parseModelRef(modelRef ?? engine.currentModel);
  if (!ref?.provider || !ref.id || ref.id.length > 256 || ref.provider.length > 256) throw new Error('qualification_model_required');
  if (typeof engine.resolveModelWithCredentials !== 'function') throw new Error('qualification_configuration_unavailable');
  const resolved = engine.resolveModelWithCredentials(ref);
  if (!resolved?.model || resolved.model.id !== ref.id || (resolved.model.provider || resolved.provider) !== ref.provider) throw new Error('qualification_model_mismatch');
  const model = { ...resolved.model, provider: ref.provider, api: resolved.api || resolved.model.api,
    baseUrl: resolved.base_url || resolved.model.baseUrl, headers: { ...(resolved.model.headers || {}), ...(resolved.headers || {}) } };
  // Hash the complete resolved JSON configuration and credentials in memory. Never store the source values.
  const fingerprint = digest({ suite: QUALIFICATION_SUITE_VERSION, model, apiKey: resolved.api_key || '', headers: resolved.headers || {} });
  return { model, resolved, fingerprint };
}

function capabilities(value: unknown, defaults: readonly ModelCapability[]): ModelCapability[] {
  if (value === undefined) return [...defaults];
  if (!Array.isArray(value) || !value.length || value.length > CAPABILITIES.length || value.some(item => !CAPABILITIES.includes(item))) throw new Error('invalid_qualification_capabilities');
  return [...new Set(value)] as ModelCapability[];
}
function limits(value: any): QualificationBudget {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1 || value.maxCalls > 4
      || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 20_000_000
      || typeof value.maxUsd !== 'number' || !Number.isFinite(value.maxUsd) || value.maxUsd <= 0 || value.maxUsd > 100
      || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1 || value.maxDurationMs > 120_000) throw new Error('invalid_qualification_budget');
  return { maxCalls: value.maxCalls, maxTokens: value.maxTokens, maxUsd: value.maxUsd, maxDurationMs: value.maxDurationMs };
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('request_aborted');
  let listener: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { listener = () => reject(new Error('request_aborted')); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', listener!); }
}

type QualifyOptions = { manual: true; modelRef?: unknown; capabilities?: ModelCapability[]; budget: QualificationBudget; signal?: AbortSignal; mediaTokenAccountingConfirmed?: boolean };
type ServiceOptions = { directory?: string; now?: () => number; invoke?: (model: any, context: any, options: any) => Promise<any> };

/** The only injection seam is trusted construction. Request bodies cannot supply a transport or a report. */
export class ModelQualificationService {
  private readonly store: QualificationStore;
  private readonly now: () => number;
  private active = false;
  private readonly engine: any;
  private readonly options: ServiceOptions;
  constructor(engine: any, options: ServiceOptions = {}) {
    this.engine = engine;
    this.options = options;
    this.store = new QualificationStore(options.directory || (engine.codiaHome ? path.join(engine.codiaHome, 'model-qualification') : null));
    this.now = options.now || Date.now;
  }
  inspect(options: { modelRef?: unknown; requiredCapabilities?: ModelCapability[] } = {}): QualificationInspection {
    let selected: ReturnType<typeof resolveQualificationModel>;
    let required: ModelCapability[];
    try { selected = resolveQualificationModel(this.engine, options.modelRef); required = capabilities(options.requiredCapabilities, ['text', 'tool']); }
    catch { return { state: 'unknown', reason: 'model_configuration_unavailable', fingerprint: null, report: null }; }
    const report = this.store.read(selected.model);
    const inspection = (state: QualificationInspection['state'], reason: string) => ({ state, reason, fingerprint: selected.fingerprint, report });
    if (!report) return inspection('unknown', 'qualification_not_run');
    if (report.provenance !== 'configured-provider') return inspection('unknown', 'test_evidence_not_runtime_qualification');
    if (report.fingerprint !== selected.fingerprint) return inspection('unknown', 'model_configuration_changed');
    if (report.status !== 'completed') return inspection('unknown', 'qualification_incomplete');
    if (report.expiresAt <= this.now() || report.startedAt > this.now() || report.finishedAt === null || report.finishedAt < report.startedAt) return inspection('unknown', 'qualification_expired');
    const checks = required.map(cap => report.results.find(item => item.capability === cap));
    if (checks.some(check => check?.status === 'fail' || check?.status === 'unsupported')) return inspection('fail', 'required_capability_failed');
    if (checks.some(check => check?.status !== 'pass')) return inspection('unknown', 'required_capability_not_qualified');
    return inspection('pass', 'fixed_capability_cases_passed');
  }
  async qualify(options: QualifyOptions): Promise<QualificationReport> {
    if (options?.manual !== true) throw new Error('manual_qualification_required');
    if (this.active) throw new Error('qualification_already_running');
    const requested = capabilities(options.capabilities, CAPABILITIES);
    const allowance = limits(options.budget);
    const selected = resolveQualificationModel(this.engine, options.modelRef);
    const modelRef = { id: selected.model.id, provider: selected.model.provider };
    const report: QualificationReport = {
      id: randomUUID(), suiteVersion: QUALIFICATION_SUITE_VERSION, model: { ...modelRef, api: selected.model.api }, fingerprint: selected.fingerprint,
      provenance: this.options.invoke ? 'test-injected' : 'configured-provider', status: 'running', startedAt: this.now(), finishedAt: null,
      mediaAccounting: options.mediaTokenAccountingConfirmed === true ? 'fixture-input-token-estimate-confirmed' : 'unconfirmed',
      expiresAt: this.now() + QUALIFICATION_TTL_MS, results: CAPABILITIES.map(cap => result(cap, 'not-run', 'not_requested')), budget: null, note: NOTE,
    };
    // Invalidates an older pass before any network dispatch. A crash leaves an incomplete record.
    this.active = true;
    let budget: RunBudget | null = null;
    const duration = new AbortController();
    const timer = setTimeout(() => duration.abort(), allowance.maxDurationMs);
    const signal = options.signal ? AbortSignal.any([options.signal, duration.signal]) : duration.signal;
    try {
      this.store.write(report);
      const runLimits = { ...allowance, maxSteps: allowance.maxCalls, maxModelCalls: allowance.maxCalls, maxOutputTokensPerCall: OUTPUT_TOKEN_CAP };
      try { budget = createRunBudget(runLimits, selected.model); }
      catch {
        report.budget = { ...inspectRunBudget(runLimits, selected.model), state: 'blocked', limits: allowance };
        for (const cap of requested) report.results[CAPABILITIES.indexOf(cap)] = result(cap, 'blocked', 'budget_blocked');
        report.status = 'completed'; report.finishedAt = this.now(); this.store.write(report); return report;
      }
      for (const capability of requested) {
        let check = result(capability, 'blocked', 'budget_blocked');
        report.results[CAPABILITIES.indexOf(capability)] = check;
        const unsupported = unsupportedReason(selected.model, capability)
          || (capability === 'vision' && options.mediaTokenAccountingConfirmed !== true ? 'media_pricing_unverified' : null);
        if (unsupported) { Object.assign(check, result(capability, 'unsupported', unsupported)); continue; }
        if (signal.aborted) { Object.assign(check, result(capability, 'blocked', 'request_aborted')); continue; }
        try {
          if (resolveQualificationModel(this.engine, modelRef).fingerprint !== selected.fingerprint) {
            Object.assign(check, result(capability, 'blocked', 'configuration_changed')); continue;
          }
          budget.assertActive();
        } catch { continue; }
        let reservation: ReturnType<RunBudget['reserve']>;
        try { reservation = budget.reserve(selected.model); } catch { continue; }
        const started = this.now();
        const requestId = randomUUID();
        check.requestId = requestId;
        let payloadObserved = false;
        let httpStatus = 0;
        const usageRequest = this.engine.usageLedger?.start?.({
          requestId, model: { provider: selected.model.provider, modelId: selected.model.id, api: selected.model.api }, costRates: selected.model.cost,
          usageContext: { source: { subsystem: 'utility', operation: 'model_capability_qualification', surface: 'settings', trigger: 'manual' }, attribution: { kind: 'utility', agentId: this.engine.currentAgentId || null } },
          metadata: { qualificationId: report.id, suiteVersion: QUALIFICATION_SUITE_VERSION, capability, configFingerprint: selected.fingerprint },
        });
        try {
          const invoke = this.options.invoke || (async (model: any, context: any, requestOptions: any) => {
            if (typeof this.engine.modelRegistry?.streamSimple !== 'function') throw new Error('provider_runtime_unavailable');
            const stream = await this.engine.modelRegistry.streamSimple(model, context, requestOptions);
            return await stream.result();
          });
          const response = await abortable(invoke(selected.model, buildQualificationCase(capability, started), {
            apiKey: selected.resolved.api_key, headers: selected.model.headers, signal,
            maxTokens: reservation.maxOutputTokens, maxRetries: 0, timeoutMs: Math.min(30_000, allowance.maxDurationMs), cacheRetention: 'none', transport: 'sse', reasoning: 'off',
            ...(capability === 'tool' ? { toolChoice: 'auto' } : {}),
            onResponse: (response: any) => { httpStatus = Number(response?.status) || 0; },
            onPayload: (payload: any, actualModel: any) => {
              budget!.assertActive();
              if (signal.aborted) throw new Error('request_aborted');
              if (actualModel && (actualModel.id !== selected.model.id || actualModel.provider !== selected.model.provider || actualModel.api !== selected.model.api)) throw new Error('response_model_mismatch');
              const next = buildQualificationPayload(payload, selected.model, capability, reservation.maxOutputTokens);
              payloadObserved = true; return next;
            },
          }), signal);
          if (signal.aborted) throw new Error('request_aborted');
          // Missing/uncertain usage retains the reservation and blocks every later call.
          budget.settle(reservation.id, response?.usage);
          this.engine.usageLedger?.finish?.(usageRequest?.requestId, { usage: response?.usage, model: { provider: selected.model.provider, modelId: selected.model.id, api: selected.model.api }, costRates: selected.model.cost });
          const code = response?.model !== selected.model.id || response?.provider !== selected.model.provider || response?.api !== selected.model.api ? 'response_model_mismatch'
            : validateQualificationResponse(capability, response, payloadObserved);
          Object.assign(check, { status: code ? 'fail' : 'pass', code: code || 'case_passed', suggestion: code ? suggestions[code] || '供应商回复未通过能力契约。' : '固定样例已通过。',
            responseDigest: digest((response?.content || []).filter((block: any) => ['text', 'toolCall'].includes(block.type))) });
        } catch {
          const code = signal.aborted ? 'request_aborted' : httpStatus === 401 || httpStatus === 403 ? 'provider_auth_failed' : httpStatus === 429 ? 'provider_rate_limited' : 'provider_failed';
          budget.uncertain(reservation.id, code);
          this.engine.usageLedger?.recordError?.(usageRequest?.requestId, new Error(code));
          Object.assign(check, { status: 'fail', code, suggestion: suggestions[code] });
        }
        check.durationMs = Math.max(0, this.now() - started);
        report.budget = budget.snapshot();
        this.store.write(report);
      }
      report.status = signal.aborted ? 'interrupted' : 'completed';
      report.finishedAt = this.now(); report.budget = budget.snapshot();
      // A mid-flight configuration mutation invalidates even successful fixed cases.
      try { if (resolveQualificationModel(this.engine, modelRef).fingerprint !== selected.fingerprint) report.status = 'interrupted'; }
      catch { report.status = 'interrupted'; }
      this.store.write(report);
      return report;
    } finally { clearTimeout(timer); this.active = false; }
  }
}
const services = new WeakMap<object, ModelQualificationService>();
export function getModelQualificationService(engine: any): ModelQualificationService {
  let service = services.get(engine);
  if (!service) { service = new ModelQualificationService(engine); services.set(engine, service); }
  return service;
}
