const CONFIRMATION_MODES = new Set(["text_command"]);

export function createInteractionCapabilities({ platform, confirmationMode, source = "" }: {
  platform: string;
  confirmationMode: string;
  source?: string;
}) {
  if (!platform) throw new Error("interaction capability requires platform");
  if (!CONFIRMATION_MODES.has(confirmationMode)) {
    throw new Error(`unsupported confirmation mode: ${confirmationMode}`);
  }
  return Object.freeze({ platform, confirmationMode, source });
}

export const BRIDGE_INTERACTION_CAPABILITIES: Record<string, ReturnType<typeof createInteractionCapabilities>> = Object.freeze({
  wechat: createInteractionCapabilities({
    platform: "wechat",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  feishu: createInteractionCapabilities({
    platform: "feishu",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  dingtalk: createInteractionCapabilities({
    platform: "dingtalk",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  telegram: createInteractionCapabilities({
    platform: "telegram",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  qq: createInteractionCapabilities({
    platform: "qq",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  whatsapp: createInteractionCapabilities({
    platform: "whatsapp",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
});

const WUKONG_INTERACTION_CAPABILITY = createInteractionCapabilities({
  platform: "wukong",
  confirmationMode: "text_command",
  source: "server/routes/wukong.ts#tasks/run",
});

export function interactionCapabilitiesForPlatform(platform: string) {
  if (platform === "wukong") return WUKONG_INTERACTION_CAPABILITY;
  const capability = BRIDGE_INTERACTION_CAPABILITIES[platform];
  if (!capability) {
    throw new Error(`no interaction capabilities declared for platform: ${platform}`);
  }
  return capability;
}
