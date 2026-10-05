import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevGsapHome(env = process.env) {
  return env.GSAP_DEV_HOME || join(homedir(), ".gsap-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  env.GSAP_HOME = defaultDevGsapHome(env);
  env.GSAP_DEV_NODE_BIN = nodeBin;
  return env;
}
