import { TELEGRAM_MEDIA_CAPABILITIES, TELEGRAM_STREAMING_CAPABILITIES } from "./telegram-adapter.ts";
import { FEISHU_MEDIA_CAPABILITIES, FEISHU_STREAMING_CAPABILITIES } from "./feishu-adapter.ts";
import { DINGTALK_MEDIA_CAPABILITIES, DINGTALK_STREAMING_CAPABILITIES } from "./dingtalk-adapter.ts";
import { QQ_MEDIA_CAPABILITIES } from "./qq-adapter.ts";
import { WECHAT_ILINK_MEDIA_CAPABILITIES } from "./wechat-adapter.ts";
import { AGENTLY_MAIL_MEDIA_CAPABILITIES } from "./agently-mail.ts";

const WHATSAPP_MEDIA_CAPABILITIES = Object.freeze({
  platform: "whatsapp",
  inputModes: Object.freeze(["buffer", "remote_url", "public_url"]),
  supportedKinds: Object.freeze(["image", "video", "audio", "document"]),
  requiresReplyContext: false,
  deliveryByKind: Object.freeze({
    image: "native_image",
    video: "native_file",
    audio: "native_file",
    document: "native_file",
  }),
  maxBytes: Object.freeze({}),
  source: "whatsapp-web.js MessageMedia",
});

const TEXT_CAPABILITIES = Object.freeze({
  telegram: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: true }),
  feishu: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: true }),
  dingtalk: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: true }),
  qq: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: true }),
  wechat: Object.freeze({ receive: true, reply: true, proactive: false, dm: true, group: false }),
  whatsapp: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: true }),
  agentlyMail: Object.freeze({ receive: true, reply: true, proactive: true, dm: true, group: false, email: true }),
});

const MEDIA_BY_PLATFORM = Object.freeze({
  telegram: TELEGRAM_MEDIA_CAPABILITIES,
  feishu: FEISHU_MEDIA_CAPABILITIES,
  dingtalk: DINGTALK_MEDIA_CAPABILITIES,
  qq: QQ_MEDIA_CAPABILITIES,
  wechat: WECHAT_ILINK_MEDIA_CAPABILITIES,
  whatsapp: WHATSAPP_MEDIA_CAPABILITIES,
  agentlyMail: AGENTLY_MAIL_MEDIA_CAPABILITIES,
});

const STREAMING_BY_PLATFORM = Object.freeze({
  telegram: TELEGRAM_STREAMING_CAPABILITIES,
  feishu: FEISHU_STREAMING_CAPABILITIES,
  dingtalk: DINGTALK_STREAMING_CAPABILITIES,
});

function cloneFrozen(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function getBridgeCapabilityMatrix() {
  const platforms = {};
  for (const platform of Object.keys(TEXT_CAPABILITIES)) {
    platforms[platform] = {
      text: { ...TEXT_CAPABILITIES[platform] },
      media: cloneFrozen(MEDIA_BY_PLATFORM[platform]),
      streaming: cloneFrozen(STREAMING_BY_PLATFORM[platform]),
    };
  }
  return {
    surfaces: ["desktop", "pwa", "cli"],
    platforms,
  };
}
