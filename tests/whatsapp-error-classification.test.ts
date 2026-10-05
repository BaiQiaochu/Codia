import { describe, expect, it } from "vitest";
import { classifyWhatsAppError } from "../lib/bridge/whatsapp-adapter.js";

describe("classifyWhatsAppError", () => {
  it("classifies missing browser errors", () => {
    const result = classifyWhatsAppError("未找到 Chrome/Edge。请安装 Chrome 或设置 HANA_WHATSAPP_CHROME 指向浏览器路径。");
    expect(result.type).toBe("browser_missing");
  });

  it("classifies network timeout errors", () => {
    const result = classifyWhatsAppError("net::ERR_CONNECTION_TIMED_OUT at https://web.whatsapp.com/");
    expect(result.type).toBe("network_timeout");
  });

  it("classifies session conflict errors", () => {
    const result = classifyWhatsAppError("CONFLICT");
    expect(result.type).toBe("session_conflict");
  });
});
