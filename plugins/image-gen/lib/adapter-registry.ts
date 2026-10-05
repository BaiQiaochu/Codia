/**
 * plugins/image-gen/lib/adapter-registry.js
 *
 * Registry for media generation adapters. Supports typed queries
 * and default adapter resolution. External adapters register via bus.
 */

export class AdapterRegistry {
  _adapters: Map<string, any>;
  _protocolAdapters: Map<string, any>;
  _adapterKeys: Map<string, any>;

  constructor() {
    this._adapters = new Map();
    this._protocolAdapters = new Map();
    this._adapterKeys = new Map();
  }

  register(adapter: any) {
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

  get(adapterId: string) {
    return this._adapters.get(adapterId) || null;
  }

  getProtocol(protocolId: string) {
    return this._protocolAdapters.get(protocolId) || null;
  }

  getByType(type: string) {
    const result = [];
    const seen = new Set();
    for (const a of this._adapters.values()) {
      if (!a.types.includes(type) || seen.has(a.id)) continue;
      seen.add(a.id);
      result.push(a);
    }
    return result;
  }

  getDefault(type: string) {
    for (const a of this._adapters.values()) {
      if (a.types.includes(type)) return a;
    }
    return null;
  }

  list() {
    const seen = new Set();
    const result = [];
    for (const adapter of this._adapters.values()) {
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }
}
