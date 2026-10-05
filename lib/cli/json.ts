// @ts-nocheck
import { CliError } from "./errors.ts";

export function parseJson(value, label = "JSON") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CliError(`${label} 解析失败: ${error.message}`);
  }
}

export function parseOptionalJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
