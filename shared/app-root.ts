import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = process.env.GSAP_ROOT || path.resolve(__dirname, "..");
export const GSAP_ROOT = APP_ROOT;

export function fromRoot(...segments) {
  return path.join(APP_ROOT, ...segments);
}
