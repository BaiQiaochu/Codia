/**
 * shared/model-ref.js — 模型引用复合键工具
 *
 * (provider, id) 是模型的唯一标识。运行时所有查找 / 比较 / 持久化
 * 必须使用完整 {id, provider}。
 *
 * 纪律：
 *   - findModel / modelRefEquals / modelRefKey：严格；缺 provider 不降级
 *   - parseModelRef：宽松；只用于 UI 展示层或迁移入口
 *   - requireModelRef：运行时严格校验入口
 */

/**
 * 宽松解析：任意历史格式 -> { id, provider }
 * - {id, provider}
 * - "provider/id"
 * - "id" -> { id, provider: "" }
 * - null/undefined/空串 -> null
 */
export type ModelRef = {
  id: string;
  provider: string;
};

type ModelLike = ModelRef & Record<string, unknown>;

export function parseModelRef(ref: unknown): ModelRef | null {
  if (!ref) return null;
  if (typeof ref === "object") {
    const value = ref as { id?: unknown; provider?: unknown };
    if (!value.id) return null;
    return { id: String(value.id), provider: typeof value.provider === "string" ? value.provider : "" };
  }
  if (typeof ref !== "string") return null;
  const s = ref.trim();
  if (!s) return null;
  const slashIdx = s.indexOf("/");
  if (slashIdx > 0 && slashIdx < s.length - 1) {
    return { provider: s.slice(0, slashIdx), id: s.slice(slashIdx + 1) };
  }
  return { id: s, provider: "" };
}

/**
 * 运行时严格校验：必须同时有 id 和 provider
 */
export function requireModelRef(ref: unknown): ModelRef {
  const parsed = parseModelRef(ref);
  if (!parsed?.id || !parsed?.provider) {
    throw new Error(`requireModelRef: missing id or provider (got ${JSON.stringify(ref)})`);
  }
  return parsed;
}

/**
 * 在 availableModels 中用复合键精确查找
 * - findModel(list, "provider/id") / findModel(list, {id, provider})
 * - 不再按裸 id 或 name 兜底
 */
export function findModel<T extends ModelLike>(available: T[] | null | undefined, id: unknown, provider?: unknown): T | null {
  if (!available) return null;
  if (typeof id === "object" && id !== null) {
    const ref = id as Partial<ModelRef>;
    return findModel(available, ref.id, ref.provider);
  }
  if (!id || !provider) {
    throw new Error(`findModel: id and provider both required (got id=${id}, provider=${provider})`);
  }
  return available.find((m) => m.id === id && m.provider === provider) || null;
}

/**
 * 严格复合键比较
 */
export function modelRefEquals(a: Partial<ModelRef> | null | undefined, b: Partial<ModelRef> | null | undefined): boolean {
  if (!a || !b) return false;
  if (!a.id || !b.id || !a.provider || !b.provider) return false;
  return a.id === b.id && a.provider === b.provider;
}

/**
 * 复合键字符串
 */
export function modelRefKey(ref: Partial<ModelRef> | null | undefined): string {
  if (!ref?.id || !ref?.provider) {
    throw new Error(`modelRefKey: missing id or provider (got ${JSON.stringify(ref)})`);
  }
  return `${ref.provider}/${ref.id}`;
}
