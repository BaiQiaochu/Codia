import { describe, expect, it } from "vitest";
import { resolveMcpStdioSpawnSpec } from "../plugins/mcp/lib/mcp-stdio-client.js";

const COMMAND = String.raw`C:\tools\server.cmd`;
const windowsOptions = { platform: "win32" as const, baseEnv: { ComSpec: "cmd.exe" }, existsSync: () => false };
const vectors = [
  ["", '^"^"'],
  ["plain", '^"plain^"'],
  ["two words", '^"two^ words^"'],
  ["中文 café", '^"中文^ café^"'],
  ["https://example.invalid/api?q=hello&mode=full", '^"https://example.invalid/api^?q=hello^&mode=full^"'],
  ["report&archive", '^"report^&archive^"'],
  ["A|B", '^"A^|B^"'],
  ["caret^literal", '^"caret^^literal^"'],
  ["(group)", '^"^(group^)^"'],
  ["%PATH%", '^"^%PATH^%^"'],
  ["!VALUE!", '^"^!VALUE^!^"'],
  ['say "hello"', '^"say^ \\^"hello\\^"^"'],
  ["C:\\Program Files\\fixture\\", '^"C:\\Program^ Files\\fixture\\\\^"'],
];

describe("Windows MCP launch planning (no native Windows process)", () => {
  it.each(vectors)("preserves the literal argument %j in its encoded launch plan", (value, encoded) => {
    const spec = resolveMcpStdioSpawnSpec({ command: COMMAND, args: [value] }, windowsOptions);
    expect(spec.command).toBe("cmd.exe");
    expect(spec.args).toEqual(["/d", "/s", "/v:off", "/c", `"${COMMAND} ${encoded}"`]);
    expect(spec.windowsVerbatimArguments).toBe(true);
  });

  it("retains empty arguments at the beginning, middle, and end", () => {
    const spec = resolveMcpStdioSpawnSpec({ command: COMMAND, args: ["", "a", "", "b", ""] }, windowsOptions);
    expect(spec.args.at(-1)).toBe(`"${COMMAND} ^"^" ^"a^" ^"^" ^"b^" ^"^""`);
  });

  it.each([0, 1, 2, 3, 4, 17, 128])("uses CRT's 2n+1 backslash rule before embedded quotes (n=%i)", (count) => {
    const value = `prefix${"\\".repeat(count)}"suffix`;
    const encoded = `^"prefix${"\\".repeat(count * 2 + 1)}^"suffix^"`;
    const spec = resolveMcpStdioSpawnSpec({ command: COMMAND, args: [value] }, windowsOptions);
    expect(spec.args.at(-1)).toBe(`"${COMMAND} ${encoded}"`);
  });

  it.each([1, 2, 3, 17, 128])("doubles all trailing backslashes before the closing quote (n=%i)", (count) => {
    const value = `path${"\\".repeat(count)}`;
    const spec = resolveMcpStdioSpawnSpec({ command: COMMAND, args: [value] }, windowsOptions);
    expect(spec.args.at(-1)).toBe(`"${COMMAND} ^"path${"\\".repeat(count * 2)}^""`);
  });

  it("applies the extra escaping layer for npm node_modules/.bin shims", () => {
    const command = String.raw`C:\project\node_modules\.bin\server.cmd`;
    const spec = resolveMcpStdioSpawnSpec({ command, args: ["", "a&b", "!VALUE!", "%PATH%"] }, windowsOptions);
    expect(spec.args.at(-1)).toBe(`"${command} ^^^"^^^" ^^^"a^^^&b^^^" ^^^"^^^!VALUE^^^!^^^" ^^^"^^^%PATH^^^%^^^""`);
  });

  it("normalizes Windows command paths and escapes command metacharacters", () => {
    const spec = resolveMcpStdioSpawnSpec({ command: "C:/Program Files (x86)/tools/server.bat", args: [] }, windowsOptions);
    expect(spec.args.at(-1)).toBe('"C:\\Program^ Files^ ^(x86^)\\tools\\server.bat"');
  });

  it.each([".exe", ".com"])("keeps %s native argv unmodified, including metacharacters and empty values", (extension) => {
    const command = `C:\\tools\\server${extension}`;
    const args = [...vectors.map(([value]) => value), "first\nsecond"];
    const spec = resolveMcpStdioSpawnSpec({ command, args }, windowsOptions);
    expect(spec.command).toBe(command);
    expect(spec.args).toEqual(args);
    expect(spec.windowsVerbatimArguments).not.toBe(true);
  });

  it.each(["linux", "darwin", "direct"] as const)("does not change the %s argv or environment contract", (platform) => {
    const args = vectors.map(([value]) => value);
    const spec = resolveMcpStdioSpawnSpec({
      command: "/opt/my tools/server", args, env: { LOCAL_MODE: "fixture" }, registryUrl: "https://registry.example.invalid",
    }, { ...windowsOptions, platform, baseEnv: { PATH: "/bin" } });
    expect(spec).toEqual({
      command: "/opt/my tools/server", args,
      env: { PATH: "/bin", LOCAL_MODE: "fixture", NPM_CONFIG_REGISTRY: "https://registry.example.invalid" },
    });
  });

  it.each(["line\nbreak", "line\rbreak", "nul\0byte"])("rejects unsupported batch control characters instead of interpreting them: %j", (value) => {
    expect(() => resolveMcpStdioSpawnSpec({ command: COMMAND, args: [value] }, windowsOptions)).toThrow(/NUL or line breaks/);
  });
});
