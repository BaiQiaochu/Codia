/**
 * Generic registry for provider-side media adapters.
 *
 * Provider declarations say a model exists; adapter registration says this
 * runtime can execute the model protocol.
 */

export type MediaAdapterSubmitResult = {
  taskId?: string;
  providerTaskId?: string;
  adapterTaskId?: string;
  files?: string[];
  [key: string]: unknown;
};

export type MediaAdapter = {
  id: string;
  aliases?: string[];
  protocolId?: string;
  protocolIds?: string[];
  types?: string[];
  submit?: (params: Record<string, unknown>, ctx: unknown) => Promise<MediaAdapterSubmitResult>;
  [key: string]: unknown;
};

export class MediaAdapterRegistry {
  private _adapters: Map<string, MediaAdapter>;
  private _protocolAdapters: Map<string, MediaAdapter>;
  private _adapterKeys: Map<string, { aliases: string[]; protocolIds: string[] }>;

  constructor() {
    this._adapters = new Map();
    this._protocolAdapters = new Map();
    this._adapterKeys = new Map();
  }

  register(adapter: MediaAdapter) {
    if (!adapter?.id) throw new Error("media adapter requires id");
    this._adapters.set(adapter.id, adapter);
    const aliases = Array.isArray(adapter.aliases) ? adapter.aliases.filter(Boolean) : [];
    const protocolIds = [
      ...(adapter.protocolId ? [adapter.protocolId] : []),
      ...(Array.isArray(adapter.protocolIds) ? adapter.protocolIds : []),
    ].filter(Boolean);
    for (const alias of aliases) this._adapters.set(alias, adapter);
    for (const protocolId of protocolIds) this._protocolAdapters.set(protocolId, adapter);
    this._adapterKeys.set(adapter.id, { aliases, protocolIds });
  }

  unregister(adapterId: string) {
    const adapter = this._adapters.get(adapterId);
    const canonicalId = adapter?.id || adapterId;
    const keys = this._adapterKeys.get(canonicalId);
    this._adapters.delete(canonicalId);
    for (const alias of keys?.aliases || []) this._adapters.delete(alias);
    for (const protocolId of keys?.protocolIds || []) this._protocolAdapters.delete(protocolId);
    this._adapterKeys.delete(canonicalId);
  }

  get(adapterId: string | null | undefined) {
    return this._adapters.get(adapterId) || null;
  }

  getProtocol(protocolId: string | null | undefined) {
    return this._protocolAdapters.get(protocolId) || null;
  }

  getByType(type: string) {
    const result: MediaAdapter[] = [];
    const seen = new Set<string>();
    for (const adapter of this._adapters.values()) {
      if (!Array.isArray(adapter.types) || !adapter.types.includes(type) || seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }

  getDefault(type: string) {
    for (const adapter of this._adapters.values()) {
      if (Array.isArray(adapter.types) && adapter.types.includes(type)) return adapter;
    }
    return null;
  }

  list() {
    const seen = new Set<string>();
    const result: MediaAdapter[] = [];
    for (const adapter of this._adapters.values()) {
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }
}
