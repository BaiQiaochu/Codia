import { describe, expect, it } from "vitest";
import {
  parseAgentlyMailAddress,
  parseAgentlyMailAuthUrl,
} from "../lib/bridge/agently-mail.ts";

describe("agently mail cli helpers", () => {
  it("extracts the opaque OAuth URL without rewriting it", () => {
    const url = "https://agent.qq.com/auth/login?ticket=a%2Fb+c&state=raw_123";
    const output = `请点击或复制以下链接在浏览器中完成授权：\r\n${url}\r\n`;

    expect(parseAgentlyMailAuthUrl(output)).toBe(url);
  });

  it("extracts the authorized mailbox from +me output", () => {
    const output = "邮箱地址 team-agent@qq.com 已授权成功，可以用它来收发邮件了";

    expect(parseAgentlyMailAddress(output)).toBe("team-agent@qq.com");
  });

  it("returns null for output without a mailbox address", () => {
    expect(parseAgentlyMailAddress("not logged in")).toBeNull();
  });
});
