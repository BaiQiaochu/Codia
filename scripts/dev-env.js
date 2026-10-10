import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevCodiaHome(env = process.env) {
  return env.CODIA_DEV_HOME || join(homedir(), ".codia-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  env.CODIA_HOME = defaultDevCodiaHome(env);
  env.CODIA_DEV_NODE_BIN = nodeBin;
  return env;
}
