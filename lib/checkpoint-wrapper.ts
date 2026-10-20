import path from "path";
import { withToolEditContext, withFileMutation } from "./resource-io/tool-edit-context.ts";

export function wrapWithCheckpoint(tools, { store, maxFileSizeKb, cwd, getSessionPath }) {
  return tools.map((tool) => {
    if (tool.name === "write" || tool.name === "edit") {
      return wrapPathTool(tool, store, maxFileSizeKb, cwd, getSessionPath);
    }
    if (tool.name === "bash") {
      return wrapBashTool(tool, store, maxFileSizeKb, cwd, getSessionPath);
    }
    return tool;
  });
}

function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.resolve(cwd || process.cwd(), rawPath);
}

function wrapPathTool(tool, store, maxFileSizeKb, cwd, getSessionPath) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const filePath = resolvePath(params.path, cwd);
      let checkpointId = null;
      const invoke = async () => {
      if (filePath) {
        try {
          checkpointId = await store.save({
            sessionPath: getSessionPath(),
            tool: tool.name,
            filePath,
            maxSizeKb: maxFileSizeKb,
          });
        } catch (error) {
          throw new Error(`Checkpoint backup failed; no file change was made. Retry after fixing the backup location: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const result = await withToolEditContext(() => tool.execute(toolCallId, params, ...rest));
      return { ...result, details: { ...result?.details, checkpointId,
        recoveryCoverage: checkpointId ? "file_snapshot" : "not_snapshotted",
        ...(checkpointId ? {} : { recoveryNote: "No prior text snapshot: file is new, binary, or exceeds the configured backup size." }) } };
      };
      return filePath ? withFileMutation(filePath, invoke) : invoke();
    },
  };
}

const RM_PATTERN = /\brm\s+(?:-[^\s]*\s+)*([^\s|;&]+)/;
const MV_PATTERN = /\bmv\s+(?:-[^\s]*\s+)*([^\s|;&]+)\s+[^\s|;&]+/;

function wrapBashTool(tool, store, maxFileSizeKb, cwd, getSessionPath) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const cmd = params.command || "";

      let match;
      if ((match = RM_PATTERN.exec(cmd))) {
        const filePath = resolvePath(match[1], cwd);
        if (filePath) {
          try {
            await store.save({
              sessionPath: getSessionPath(),
              tool: "bash:rm",
              filePath,
              maxSizeKb: maxFileSizeKb,
            });
          } catch (error) {
            throw new Error(`Checkpoint backup failed; command was not executed: ${error.message}`);
          }
        }
      } else if ((match = MV_PATTERN.exec(cmd))) {
        const filePath = resolvePath(match[1], cwd);
        if (filePath) {
          try {
            await store.save({
              sessionPath: getSessionPath(),
              tool: "bash:mv",
              filePath,
              maxSizeKb: maxFileSizeKb,
            });
          } catch (error) {
            throw new Error(`Checkpoint backup failed; command was not executed: ${error.message}`);
          }
        }
      }

      const result = await tool.execute(toolCallId, params, ...rest);
      return { ...result, details: { ...result?.details, recoveryCoverage: 'partial',
        recoveryNote: 'Shell changes are not fully checkpointed. Only recognized file operands may have backups.' } };
    },
  };
}
