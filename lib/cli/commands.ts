// @ts-nocheck
import { CliError } from "./errors.ts";

const ALIASES = new Map([
  ["run", "exec"],
  ["status", "health"],
  ["send", "chat"],
  ["repl", "interactive"],
  ["shell", "interactive"],
  ["session", "sessions"],
  ["model", "models"],
  ["agent", "agents"],
  ["skill", "skills"],
  ["cmds", "commands"],
  ["server", "serve"],
]);

export function normalizeCommandName(command) {
  return ALIASES.get(command) || command;
}

function requireHandler(handlers, name, command) {
  const handler = handlers?.[name];
  if (typeof handler !== "function") throw new CliError(`CLI handler missing for command: ${command}`);
  return handler;
}

export async function dispatchCliCommand(client, command, args, opts, handlers) {
  if (command === "resume") {
    return await requireHandler(handlers, "commandResume", command)(client, args, opts);
  }

  const normalized = normalizeCommandName(command);
  switch (normalized) {
    case "help":
    case "--help":
    case "-h":
      return await requireHandler(handlers, "commandHelp", command)(client, args, opts);
    case "health":
      return await requireHandler(handlers, "commandHealth", command)(client, args, opts);
    case "chat":
      return await requireHandler(handlers, "commandChat", command)(client, args, opts);
    case "exec":
      return await requireHandler(handlers, "commandExec", command)(client, args, opts);
    case "doctor":
      return await requireHandler(handlers, "commandDoctor", command)(client, args, opts);
    case "interactive":
      return await requireHandler(handlers, "commandInteractive", command)(client, args, opts);
    case "sessions":
      return await requireHandler(handlers, "commandSessions", command)(client, args, opts);
    case "models":
      return await requireHandler(handlers, "commandModels", command)(client, args, opts);
    case "agents":
      return await requireHandler(handlers, "commandAgents", command)(client, args, opts);
    case "skills":
      return await requireHandler(handlers, "commandSkills", command)(client, args, opts);
    case "commands":
      return await requireHandler(handlers, "commandCommands", command)(client, args, opts);
    case "config":
      return await requireHandler(handlers, "commandConfig", command)(client, args, opts);
    case "serve":
      return await requireHandler(handlers, "commandServe", command)(client, args, opts);
    case "permissions":
      return await requireHandler(handlers, "commandPermissions", command)(client, args, opts);
    case "fs":
      return await requireHandler(handlers, "commandFs", command)(client, args, opts);
    case "raw":
      return await requireHandler(handlers, "commandRaw", command)(client, args, opts);
    default: {
      const help = typeof handlers?.helpText === "function" ? `\n\n${handlers.helpText()}` : "";
      throw new CliError(`未知命令: ${command}${help}`);
    }
  }
}
