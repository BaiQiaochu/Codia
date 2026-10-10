import { LocalFsProvider } from "./providers/local-fs-provider.ts";
import path from "path";
import { MountProvider } from "./providers/mount-provider.ts";
import { ResourceProvider } from "./providers/resource-provider.ts";
import { SessionFileResolverProvider } from "./providers/session-file-resolver.ts";
import { UrlProvider } from "./providers/url-provider.ts";
import { ResourceAccessPolicy } from "./resource-access-policy.ts";
import { ResourceEventBus } from "./resource-event-bus.ts";
import { ResourceIO } from "./resource-io.ts";

type Options = {
  cwd: string;
  agentDir: string;
  workspace?: string | null;
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  getAuthorizedFolders?: () => string[];
  codiaHome?: string;
  getSandboxEnabled?: () => boolean;
  getExternalReadPaths?: () => string[];
  getSessionPath?: () => string | null;
  emitEvent?: (event: object, sessionPath?: string | null) => void;
  sessionFiles?: any;
  resolveSessionFile?: (fileId: string, options?: { sessionId?: string | null; sessionPath?: string | null }) => any;
  resourceService?: any;
  studioId?: string | null;
  urlMaterializeRoot?: string;
};

export function createSandboxResourceIO({
  cwd,
  agentDir,
  workspace,
  workspaceFolders = [],
  authorizedFolders = [],
  getAuthorizedFolders,
  codiaHome,
  getSandboxEnabled,
  getExternalReadPaths,
  getSessionPath,
  emitEvent,
  sessionFiles,
  resolveSessionFile,
  resourceService,
  studioId,
  urlMaterializeRoot,
}: Options) {
  const home = codiaHome || "";
  const resourceAccessGuard = new ResourceAccessPolicy({
    agentDir,
    cwd,
    workspace,
    workspaceFolders,
    codiaHome: home,
    getAuthorizedFolders: typeof getAuthorizedFolders === "function"
      ? getAuthorizedFolders
      : () => Array.isArray(authorizedFolders) ? authorizedFolders : [],
    getSandboxEnabled: typeof getSandboxEnabled === "function" ? getSandboxEnabled : () => false,
    getExternalReadPaths,
  });

  const trashRoot = path.join(home, "trash");
  const localFsProviderFactory = ({ cwd: providerCwd, guard }) => new LocalFsProvider({ cwd: providerCwd, guard, trashRoot });
  const providers: Record<string, any> = {
    local_fs: localFsProviderFactory({ cwd, guard: resourceAccessGuard }),
    url: new UrlProvider({ materializeRoot: urlMaterializeRoot }),
  };
  const sessionFileStore = sessionFiles || (resolveSessionFile ? { get: resolveSessionFile } : null);
  if (sessionFileStore) {
    providers.session_file = new SessionFileResolverProvider({ sessionFiles: sessionFileStore });
  }
  if (resourceService) {
    providers.resource = new ResourceProvider({ resourceService });
  }
  if (studioId) {
    providers.mount = new MountProvider({
      codiaHome: home,
      studioId,
      localFsProviderFactory,
    });
  }

  return new ResourceIO({
    providers,
    eventBus: new ResourceEventBus({
      emit: (event, sessionPath) => emitEvent?.(event, sessionPath),
    }),
    getSessionPath: () => getSessionPath?.() || null,
  });
}
