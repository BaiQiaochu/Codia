// @ts-nocheck
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

export function createColorPalette(enabled = true) {
  const values = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
  };
  if (enabled) return values;
  return Object.fromEntries(Object.keys(values).map((key) => [key, ""]));
}

export function paint(color, name, text) {
  return `${color?.[name] || ""}${text}${color?.reset || ""}`;
}

export function stripAnsi(text) {
  return String(text || "").replace(ANSI_ESCAPE_PATTERN, "");
}

export function textWidth(text) {
  return Array.from(stripAnsi(text)).reduce((width, char) => width + (char.charCodeAt(0) > 0xff ? 2 : 1), 0);
}

export function fitText(text, maxWidth) {
  const value = String(text || "");
  if (value.includes(`${ANSI_ESCAPE}[`)) return value;
  if (textWidth(value) <= maxWidth) return value;
  let out = "";
  for (const char of Array.from(value)) {
    if (textWidth(`${out}${char}...`) > maxWidth) break;
    out += char;
  }
  return `${out}...`;
}

export function padRight(text, width) {
  const value = String(text || "");
  return value + " ".repeat(Math.max(0, width - textWidth(value)));
}

export function drawCliCardToString(lines, width = 58) {
  const inner = width - 4;
  const rows = [`╭${"─".repeat(width - 2)}╮`];
  for (const line of lines) rows.push(`│ ${padRight(fitText(line, inner), inner)} │`);
  rows.push(`╰${"─".repeat(width - 2)}╯`);
  return `${rows.join("\n")}\n`;
}

export function writeCliCard(output, lines, width = 58) {
  output.write(drawCliCardToString(lines, width));
}

export function printJson(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}
