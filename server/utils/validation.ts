import fs from "fs";
import path from "path";

export function validateId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
}

export function agentExists(engine: { agentsDir: string }, id: string): boolean {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}
