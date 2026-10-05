export type PluginRouteAccessLevel = "full-access" | "restricted";

export interface PluginRouteRequestPrincipal {
  kind?: string | null;
  pluginId?: string | null;
  principalId?: string | null;
  credentialId?: string | null;
  credentialKind?: string | null;
  connectionKind?: string | null;
  [key: string]: unknown;
}

export class PluginBusCapabilityError extends Error {
  declare code: string;
  declare status: number;
  declare capability: string;
  declare permission: string | null;
  declare pluginId: string;
  declare declared: boolean;
  declare granted: boolean;

  constructor(message: string, {
    code,
    capability,
    permission,
    pluginId,
    declared,
    granted,
  }: {
    code: string;
    capability: string;
    permission: string | null;
    pluginId: string;
    declared: boolean;
    granted: boolean;
  }) {
    super(message);
    this.name = "PluginBusCapabilityError";
    this.code = code;
    this.status = 403;
    this.capability = capability;
    this.permission = permission;
    this.pluginId = pluginId;
    this.declared = declared;
    this.granted = granted;
  }
}

export function isPluginBusCapabilityError(err: unknown): err is PluginBusCapabilityError {
  if (err instanceof PluginBusCapabilityError) return true;
  return !!err
    && typeof err === "object"
    && typeof (err as any).code === "string"
    && (err as any).code.startsWith("PLUGIN_CAPABILITY_");
}

export function createPluginRouteRequestContext({
  pluginCtx,
  accessLevel,
  capabilities,
  sensitiveCapabilities,
  principal = null,
  agentId = null,
}: {
  pluginCtx: { pluginId?: string; bus?: any };
  accessLevel?: PluginRouteAccessLevel | string | null;
  capabilities?: string[] | null;
  sensitiveCapabilities?: string[] | null;
  principal?: PluginRouteRequestPrincipal | null;
  agentId?: string | null;
}) {
  if (!pluginCtx || typeof pluginCtx !== "object") {
    throw new Error("createPluginRouteRequestContext requires pluginCtx");
  }
  const pluginBus = pluginCtx.bus;
  if (!pluginBus || typeof pluginBus.request !== "function") {
    throw new Error("createPluginRouteRequestContext requires pluginCtx.bus");
  }
  const pluginId = typeof pluginCtx.pluginId === "string" && pluginCtx.pluginId
    ? pluginCtx.pluginId
    : "unknown-plugin";
  const resolvedAccess: PluginRouteAccessLevel = accessLevel === "full-access" ? "full-access" : "restricted";
  const declaredPermissions = normalizeDeclarations(capabilities, sensitiveCapabilities);
  const legacyDeclaration = capabilities == null && sensitiveCapabilities == null;

  const getCapability = typeof pluginBus.getCapability === "function"
    ? pluginBus.getCapability.bind(pluginBus)
    : () => null;

  function assertCapabilityGrant(type: string) {
    const capability = getCapability(type);
    if (!capability || capability.owner !== "system") return;
    const permission = typeof capability.permission === "string" && capability.permission.trim()
      ? capability.permission.trim()
      : null;
    if (!permission) return;
    const declared = legacyDeclaration || declarationAllows(declaredPermissions, permission);
    const granted = resolvedAccess === "full-access";
    if (!granted) {
      throw new PluginBusCapabilityError(
        `Plugin "${pluginId}" is not granted bus capability "${type}" (permission "${permission}"): `
        + "the user has not enabled full access for this plugin.",
        {
          code: "PLUGIN_CAPABILITY_NOT_GRANTED",
          capability: type,
          permission,
          pluginId,
          declared,
          granted,
        },
      );
    }
    if (!declared) {
      throw new PluginBusCapabilityError(
        `Plugin "${pluginId}" did not declare bus capability "${type}" (permission "${permission}"): `
        + `add "${permission}" or its namespace to manifest capabilities or sensitiveCapabilities.`,
        {
          code: "PLUGIN_CAPABILITY_NOT_DECLARED",
          capability: type,
          permission,
          pluginId,
          declared,
          granted,
        },
      );
    }
  }

  const requestBus = Object.freeze({
    emit(event: any, sessionPath: any) {
      return pluginBus.emit(event, sessionPath);
    },
    subscribe(callback: any, filter: any = {}) {
      return pluginBus.subscribe(callback, filter);
    },
    async request(type: string, payload?: any, options?: any) {
      assertCapabilityGrant(type);
      return pluginBus.request(type, payload, options);
    },
    hasHandler(type: string) {
      return typeof pluginBus.hasHandler === "function" ? pluginBus.hasHandler(type) : false;
    },
    getCapability,
    listCapabilities: typeof pluginBus.listCapabilities === "function"
      ? pluginBus.listCapabilities.bind(pluginBus)
      : () => [],
  });

  return Object.freeze({
    pluginId,
    agentId: typeof agentId === "string" && agentId ? agentId : null,
    principal: freezePrincipal(principal),
    capabilityGrant: Object.freeze({
      accessLevel: resolvedAccess,
      declaredPermissions: Object.freeze([...declaredPermissions]) as readonly string[],
      legacyDeclaration,
    }),
    bus: requestBus,
  });
}

function normalizeDeclarations(capabilities?: string[] | null, sensitiveCapabilities?: string[] | null) {
  const merged = new Set<string>();
  for (const list of [capabilities, sensitiveCapabilities]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && item.trim()) merged.add(item.trim());
    }
  }
  return merged;
}

function declarationAllows(declared: Set<string>, permission: string) {
  if (declared.has("*")) return true;
  if (declared.has(permission)) return true;
  const [namespace] = permission.split(".");
  return declared.has(namespace) || declared.has(`${namespace}.*`);
}

function freezePrincipal(principal: PluginRouteRequestPrincipal | null) {
  if (!principal || typeof principal !== "object") return null;
  if (Object.isFrozen(principal)) return principal;
  return Object.freeze({ ...principal });
}
