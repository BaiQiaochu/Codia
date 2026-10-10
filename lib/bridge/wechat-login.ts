/**
 * wechat-login.js -微信 iLink 扫码登录模块
 *
  * */

import QRCode from "qrcode";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";

/**
  * */
function loginHeaders() {
  return {
    "iLink-App-ClientVersion": "1",
  };
}

/**
 * 获取微信扫码登录二维- * @returns {Promise<{ ok: boolean, qrcodeUrl-: string, qrcodeId-: string, error-: string }>}
 */
export async function getWechatQrcode() {
  try {
    const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const res = await fetch(url, { headers: loginHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }
    const data = await res.json();
    if (!data.qrcode) {
      return { ok: false, error: "Server did not return a QR code" };
    }
 // qrcode_img_content 是要被编码成二维码的 URL 文本，不是图- // -qrcode 库转-data URL（base64 PNG），前端直接 <img src> 显示
    const qrText = data.qrcode_img_content || data.qrcode;
    const qrcodeDataUrl = await QRCode.toDataURL(qrText, { width: 280, margin: 2 });
    return {
      ok: true,
      qrcodeUrl: qrcodeDataUrl,
      qrcodeId: data.qrcode,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 轮询微信扫码状- *
  *
 */
export async function pollWechatQrcodeStatus(qrcodeId) {
  if (!qrcodeId) {
    return { status: "error", error: "qrcodeId is required" };
  }

  try {
    const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);

    let res;
    try {
      res = await fetch(url, { headers: loginHeaders(), signal: controller.signal });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        return { status: "waiting" };
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: "error", error: `HTTP ${res.status}: ${body}` };
    }

    const data = await res.json();

    switch (data.status) {
      case "wait":
        return { status: "waiting" };
      case "scaned":
        return { status: "scanned" };
      case "confirmed":
        if (!data.bot_token || !data.ilink_bot_id) {
          return { status: "error", error: "Login succeeded but the server did not return credentials" };
        }
        return {
          status: "confirmed",
          botToken: data.bot_token,
          botId: data.ilink_bot_id,
          userId: data.ilink_user_id,
          baseUrl: data.baseurl,
        };
      case "expired":
        return { status: "expired" };
      default:
        return { status: data.status || "waiting" };
    }
  } catch (err) {
    return { status: "error", error: err.message };
  }
}
