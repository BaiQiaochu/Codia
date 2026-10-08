type AutomationOperation = "create" | "update";

type SuggestionEntry = {
  suggestionId: string;
  shortCode: string;
  sessionPath: string | null;
  bridgeSessionKey: string | null;
  operation: AutomationOperation;
  jobData: Record<string, unknown>;
  apply: (value?: unknown) => unknown;
  createdAt: number;
  sequence: number;
};

export type AutomationSuggestionPublicEntry = Omit<SuggestionEntry, "apply" | "sequence">;

function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultShortCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export class AutomationSuggestionStore {
  private readonly entries = new Map<string, SuggestionEntry>();
  private readonly generateShortCode: () => string;
  private sequence = 0;

  constructor({ generateShortCode = defaultShortCode }: { generateShortCode?: () => string } = {}) {
    this.generateShortCode = generateShortCode;
  }

  create(entry: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    operation?: AutomationOperation;
    jobData: Record<string, unknown>;
    apply: (value?: unknown) => unknown;
  }) {
    if (!entry || typeof entry !== "object") throw new Error("automation suggestion entry is required");
    if (typeof entry.apply !== "function") throw new Error("automation suggestion apply function is required");

    const sequence = ++this.sequence;
    const suggestionId = `automation_${Date.now().toString(36)}_${sequence.toString(36)}`;
    const shortCode = this.nextShortCode();
    const stored: SuggestionEntry = {
      suggestionId,
      shortCode,
      sessionPath: text(entry.sessionPath) || null,
      bridgeSessionKey: text(entry.bridgeSessionKey) || null,
      operation: entry.operation === "update" ? "update" : "create",
      jobData: clonePlain(entry.jobData || {}),
      apply: entry.apply,
      createdAt: Date.now(),
      sequence,
    };
    this.entries.set(suggestionId, stored);
    return this.publicEntry(stored);
  }

  get(ref: string) {
    const entry = this.find({ ref });
    return entry ? this.publicEntry(entry) : null;
  }

  list(filter: { sessionPath?: string | null; bridgeSessionKey?: string | null } = {}) {
    return [...this.entries.values()]
      .filter(entry => this.matchesScope(entry, filter))
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.sequence - b.sequence))
      .map(entry => this.publicEntry(entry));
  }

  async apply({
    sessionPath = null,
    bridgeSessionKey = null,
    ref = null,
    value = undefined,
  }: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    ref?: string | null;
    value?: unknown;
  } = {}) {
    const entry = this.find({ sessionPath, bridgeSessionKey, ref });
    if (!entry) return { ok: false as const, reason: "not-found" as const };

    const result = await entry.apply(value);
    this.entries.delete(entry.suggestionId);
    return {
      ok: true as const,
      suggestion: this.publicEntry(entry),
      result,
    };
  }

  private nextShortCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = text(this.generateShortCode()) || defaultShortCode();
      if (![...this.entries.values()].some(entry => entry.shortCode === code)) return code;
    }
    return String(10000 + this.sequence);
  }

  private find({
    sessionPath = null,
    bridgeSessionKey = null,
    ref = null,
  }: {
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    ref?: string | null;
  }) {
    const scope = { sessionPath, bridgeSessionKey };
    const candidates = [...this.entries.values()]
      .filter(entry => this.matchesScope(entry, scope))
      .sort((a, b) => (b.createdAt - a.createdAt) || (b.sequence - a.sequence));
    if (!candidates.length) return null;

    const normalizedRef = text(ref);
    if (!normalizedRef) return candidates[0];
    return candidates.find(entry => (
      entry.shortCode === normalizedRef
      || entry.suggestionId === normalizedRef
    )) || null;
  }

  private matchesScope(
    entry: SuggestionEntry,
    filter: { sessionPath?: string | null; bridgeSessionKey?: string | null },
  ) {
    const bridgeSessionKey = text(filter.bridgeSessionKey);
    if (bridgeSessionKey) return entry.bridgeSessionKey === bridgeSessionKey;
    const sessionPath = text(filter.sessionPath);
    if (sessionPath) return entry.sessionPath === sessionPath;
    return false;
  }

  private publicEntry(entry: SuggestionEntry): AutomationSuggestionPublicEntry {
    return {
      suggestionId: entry.suggestionId,
      shortCode: entry.shortCode,
      sessionPath: entry.sessionPath,
      bridgeSessionKey: entry.bridgeSessionKey,
      operation: entry.operation,
      jobData: clonePlain(entry.jobData),
      createdAt: entry.createdAt,
    };
  }
}
