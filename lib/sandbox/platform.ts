/**
 * Sandbox platform detection and host tool availability checks.
 */

import { execFileSync } from "child_process";

export function detectPlatform(): "seatbelt" | "bwrap" | "win32-restricted-token" | "unsupported" {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "linux") return "bwrap";
  if (process.platform === "win32") return "win32-restricted-token";
  return "unsupported";
}

export function checkAvailability(platform: string): boolean {
  try {
    if (platform === "seatbelt") {
      execFileSync("which", ["sandbox-exec"], { stdio: "ignore" });
      return true;
    }
    if (platform === "bwrap") {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
