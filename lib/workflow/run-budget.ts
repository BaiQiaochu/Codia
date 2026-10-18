/** Local admission accounting, never a guarantee about a provider's final invoice.
 * Reserve the entire configured input window before dispatch: an approximate
 * tokenizer must not be used to promise a bounded monetary charge.
 */
export interface RunBudgetLimits {
  maxTokens: number;
  maxUsd: number;
  maxSteps: number;
  maxDurationMs: number;
  maxOutputTokensPerCall: number;
  maxModelCalls?: number;
}
export interface BudgetModel {
  id: string; provider: string; api: string; baseUrl?: string;
  contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export interface BudgetReservation {
  id: number; maxInputTokens: number; maxOutputTokens: number;
  reservedTokens: number; reservedUsd: number;
}
const SUPPORTED_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const knownRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const modelKey = (model: BudgetModel) => JSON.stringify([model.id, model.provider, model.api, model.baseUrl || '', model.contextWindow, model.maxTokens, model.cost]);
const SAFE_FAILURES = new Set([
  'provider result unknown', 'provider usage missing or inconsistent', 'provider usage missing or inconsistent; reservation retained',
  'provider usage exceeds reservation or cache price is unknown', 'provider usage exceeds reservation or cache price is unknown; further calls blocked',
  'request aborted; provider usage unknown', 'provider error or aborted response',
  'provider response ended without reliable final usage', 'provider adapter bypassed the bounded payload guard',
  'provider completed after an error or deadline', 'provider adapter omitted output cap',
  'invalid bounded provider payload', 'provider-hosted tool pricing is unsupported', 'media budget accounting is unsupported',
  'run duration budget exhausted', 'run model-call budget exhausted', 'run token reservation budget exhausted', 'run USD reservation budget exhausted',
  'run budget checkpoint persistence failed', 'provider_failed', 'provider_auth_failed', 'provider_rate_limited', 'request_aborted',
  'provider_payload_unobserved', 'response_model_mismatch', 'configuration_changed', 'budget_blocked',
]);
export function safeRunBudgetFailure(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return SAFE_FAILURES.has(message) ? message : 'provider request failed; details omitted to protect credentials';
}
export const RUN_BUDGET_NOTE = '本地按配置价格预留模型费用；每次调用先预留完整上下文窗口与输出上限，未知价格或用量会阻止后续调用。供应商可能忽略参数或另收工具等费用，这不是供应商账单硬上限。';

export function inspectRunBudget(limits: Partial<RunBudgetLimits> = {}, model?: BudgetModel | null) {
  let reason = '';
  if (!positiveInteger(limits.maxTokens) || !(typeof limits.maxUsd === 'number' && Number.isFinite(limits.maxUsd) && limits.maxUsd > 0)
      || !positiveInteger(limits.maxSteps) || limits.maxSteps > 1000
      || !positiveInteger(limits.maxDurationMs) || limits.maxDurationMs > 600_000
      || !positiveInteger(limits.maxOutputTokensPerCall)
      || (limits.maxModelCalls !== undefined && (!positiveInteger(limits.maxModelCalls) || limits.maxModelCalls > 1000))) reason = '预算必须包含有效的 token、USD、步骤、时长与单次输出上限。';
  else if (!model || !model.id || !model.provider || !SUPPORTED_APIS.has(model.api)) reason = '当前供应商适配器尚无可验证的输出上限，禁止预算执行。';
  else if (!positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens)) reason = '模型上下文或最大输出配置未知，无法安全预留。';
  else if (!knownRate(model.cost?.input) || !knownRate(model.cost?.output) || Math.max(model.cost.input, model.cost.output) === 0
      || (model.cost.cacheRead !== undefined && !knownRate(model.cost.cacheRead))
      || (model.cost.cacheWrite !== undefined && !knownRate(model.cost.cacheWrite))) reason = '模型价格未知或为零占位，禁止费用预算执行。';
  // Caching is disabled in the guarded request. Reserve the most expensive known
  // input rate as defense in depth for providers with implicit cache accounting.
  const maxInputTokens = model && positiveInteger(model.contextWindow) ? model.contextWindow : null;
  const maxOutputTokens = model && positiveInteger(model.maxTokens) && positiveInteger(limits.maxOutputTokensPerCall) ? Math.min(model.maxTokens, limits.maxOutputTokensPerCall) : null;
  const inputRate = model?.cost && knownRate(model.cost.input) ? Math.max(model.cost.input, model.cost.cacheRead ?? 0, model.cost.cacheWrite ?? 0) : null;
  const reservationTokens = maxInputTokens !== null && maxOutputTokens !== null ? maxInputTokens + maxOutputTokens : null;
  const reservationUsd = reservationTokens !== null && inputRate !== null && knownRate(model?.cost?.output)
    ? (maxInputTokens! * inputRate + maxOutputTokens! * model!.cost.output) / 1_000_000 : null;
  if (!reason && (reservationTokens! > limits.maxTokens! || reservationUsd! > limits.maxUsd!)) reason = '预算不足以预留一次完整上下文窗口与输出上限；请提高预算或选择更小窗口的模型。';
  return { state: reason ? 'fail' as const : 'pass' as const, reason: reason || '可按本地预留契约执行。', reservationTokens, reservationUsd, maxInputTokens, maxOutputTokens, note: RUN_BUDGET_NOTE };
}

export class RunBudget {
  readonly limits: Readonly<Required<RunBudgetLimits>>;
  readonly model: Readonly<BudgetModel>;
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly reservations = new Map<number, BudgetReservation>();
  private readonly listeners = new Set<(snapshot: ReturnType<RunBudget['snapshot']>) => void>();
  private nextId = 1;
  private calls = 0;
  private committedTokens = 0;
  private committedUsd = 0;
  private blockedReason: string | null = null;
  constructor(limits: RunBudgetLimits, model: BudgetModel, now = Date.now) {
    const inspection = inspectRunBudget(limits, model);
    if (inspection.state !== 'pass') throw new Error(inspection.reason);
    this.limits = Object.freeze({ ...limits, maxModelCalls: limits.maxModelCalls ?? 32 });
    this.model = Object.freeze({ ...model, cost: Object.freeze({ ...model.cost }) });
    this.now = now;
    this.startedAt = now();
  }
  subscribe(listener: (snapshot: ReturnType<RunBudget['snapshot']>) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() {
    try { for (const listener of this.listeners) listener(this.snapshot()); }
    catch (error) { this.blockedReason = 'run budget checkpoint persistence failed'; throw error; }
  }
  assertActive() {
    if (this.blockedReason) throw new Error(this.blockedReason);
    if (this.now() - this.startedAt >= this.limits.maxDurationMs) this.block('run duration budget exhausted');
  }
  private block(reason: string): never {
    this.blockedReason = reason;
    this.notify();
    throw new Error(reason);
  }
  /** No awaits: concurrent nodes share one atomic admission gate. */
  reserve(model: BudgetModel): BudgetReservation {
    this.assertActive();
    if (modelKey(model) !== modelKey(this.model)) throw new Error('run budget model or price configuration changed');
    if (this.calls >= this.limits.maxModelCalls) this.block('run model-call budget exhausted');
    const check = inspectRunBudget(this.limits, model);
    if (check.state !== 'pass') throw new Error(check.reason);
    const snapshot = this.snapshot();
    if (snapshot.committedTokens + snapshot.reservedTokens + check.reservationTokens! > this.limits.maxTokens) this.block('run token reservation budget exhausted');
    if (snapshot.committedUsd + snapshot.reservedUsd + check.reservationUsd! > this.limits.maxUsd) this.block('run USD reservation budget exhausted');
    const reservation = Object.freeze({ id: this.nextId++, maxInputTokens: check.maxInputTokens!, maxOutputTokens: check.maxOutputTokens!, reservedTokens: check.reservationTokens!, reservedUsd: check.reservationUsd! });
    this.reservations.set(reservation.id, reservation);
    this.calls++;
    this.notify(); // Durable observers run before caller is allowed to dispatch.
    return reservation;
  }
  settle(id: number, usage: any) {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('unknown or already settled budget reservation');
    const values = [usage?.input, usage?.output, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !positiveInteger(usage?.totalTokens)
        || values.reduce((a, b) => a + b, 0) !== usage.totalTokens) {
      this.uncertain(id, 'provider usage missing or inconsistent');
      throw new Error('provider usage missing or inconsistent; reservation retained');
    }
    const [input, output, cacheRead, cacheWrite] = values;
    if (input + cacheRead + cacheWrite > reservation.maxInputTokens || output > reservation.maxOutputTokens
        || (cacheRead > 0 && !knownRate(this.model.cost.cacheRead)) || (cacheWrite > 0 && !knownRate(this.model.cost.cacheWrite))) {
      this.uncertain(id, 'provider usage exceeds reservation or cache price is unknown');
      throw new Error('provider usage exceeds reservation or cache price is unknown; further calls blocked');
    }
    const usd = (input * this.model.cost.input + output * this.model.cost.output + cacheRead * (this.model.cost.cacheRead ?? 0) + cacheWrite * (this.model.cost.cacheWrite ?? 0)) / 1_000_000;
    this.reservations.delete(id);
    this.committedTokens += usage.totalTokens;
    this.committedUsd += usd;
    this.notify();
  }
  uncertain(id: number, reason = 'provider result unknown') {
    if (this.reservations.has(id)) {
      this.blockedReason = `run budget blocked: ${safeRunBudgetFailure(reason)}`;
      try { this.notify(); } catch { /* Keep the original failure and block further calls. */ }
    }
  }
  snapshot() {
    const pending = [...this.reservations.values()];
    return { state: this.blockedReason ? 'blocked' as const : 'active' as const, blockedReason: this.blockedReason,
      limits: this.limits, modelId: this.model.id, startedAt: this.startedAt, calls: this.calls,
      committedTokens: this.committedTokens, committedUsd: this.committedUsd,
      reservedTokens: pending.reduce((sum, item) => sum + item.reservedTokens, 0),
      reservedUsd: pending.reduce((sum, item) => sum + item.reservedUsd, 0), pendingCalls: pending.length,
      pricing: 'configured-local-reservation' as const, providerInvoiceHardCap: false, note: RUN_BUDGET_NOTE };
  }
}
export const createRunBudget = (limits: RunBudgetLimits, model: BudgetModel) => new RunBudget(limits, model);
