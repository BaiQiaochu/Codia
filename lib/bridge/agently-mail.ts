import { execFile as nodeExecFile } from "node:child_process";
import { createAsyncNodePtyBackend } from "../terminal/node-pty-backend.ts";

export const AGENTLY_MAIL_PLATFORM = "agentlyMail";
export const AGENTLY_MAIL_CLI = process.platform === "win32" ? "agently-cli.cmd" : "agently-cli";
export const AGENTLY_MAIL_INSTALL_COMMAND = "npm install -g @tencent-qqmail/agently-cli";
export const AGENTLY_MAIL_SKILL_INSTALL_COMMAND = "npx skills add https://agent.qq.com --skill -g -y";
export const AGENTLY_MAIL_MEDIA_CAPABILITIES = Object.freeze({
  platform: AGENTLY_MAIL_PLATFORM,
  inputModes: Object.freeze(["buffer", "remote_url", "public_url"]),
  supportedKinds: Object.freeze(["image", "video", "audio", "document"]),
  requiresReplyContext: false,
  deliveryByKind: Object.freeze({
    image: "mail_attachment",
    video: "mail_attachment",
    audio: "mail_attachment",
    document: "mail_attachment",
  }),
  maxBytes: Object.freeze({}),
  source: "Tencent QQ Mail Agent Mail attachments",
});

const AUTH_PROMPT = "请点击或复制以下链接在浏览器中完成授权：";
const AUTH_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 5_000;

type ExecFileLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

type PtyBackendLike = {
  spawn: (options: {
    command: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: NodeJS.ProcessEnv;
    onData?: (data: string) => void;
    onExit?: (event: { exitCode?: number | null; signal?: number | string | null }) => void;
  }) => { kill?: () => void };
};

export interface AgentlyMailCliServiceOptions {
  execFile?: ExecFileLike;
  ptyBackendFactory?: () => Promise<PtyBackendLike>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function textFrom(value: string | Buffer | undefined | null) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
}

function firstNonEmptyLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function cleanToken(value: string) {
  return value
    .trim()
    .replace(/^[<"'({\[]+/, "")
    .replace(/[>"')}\].,;，。；]+$/, "");
}

export function parseAgentlyMailAuthUrl(output: string): string | null {
  const match = String(output || "").match(/https?:\/\/[^\s"'<>]+/i);
  return match ? cleanToken(match[0]) : null;
}

export function parseAgentlyMailAddress(output: string): string | null {
  const match = String(output || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function normalizeError(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err || "unknown error");
}

function defaultExecFile(file: string, args: string[], options: Record<string, unknown>) {
  return new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolve, reject) => {
    nodeExecFile(file, args, options as any, (error, stdout, stderr) => {
      if (error) {
        (error as any).stdout = stdout;
        (error as any).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class AgentlyMailCliService {
  private readonly execFileImpl: ExecFileLike;
  private readonly ptyBackendFactory: () => Promise<PtyBackendLike>;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AgentlyMailCliServiceOptions = {}) {
    this.execFileImpl = options.execFile || defaultExecFile;
    this.ptyBackendFactory = options.ptyBackendFactory || (createAsyncNodePtyBackend as unknown as () => Promise<PtyBackendLike>);
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
  }

  async checkCli() {
    try {
      const { stdout, stderr } = await this.execFileImpl(AGENTLY_MAIL_CLI, ["--version"], {
        cwd: this.cwd,
        env: this.env,
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      });
      return {
        available: true,
        version: firstNonEmptyLine(`${textFrom(stdout)}\n${textFrom(stderr)}`),
        installCommand: AGENTLY_MAIL_INSTALL_COMMAND,
        skillInstallCommand: AGENTLY_MAIL_SKILL_INSTALL_COMMAND,
      };
    } catch (err) {
      return {
        available: false,
        error: normalizeError(err),
        installCommand: AGENTLY_MAIL_INSTALL_COMMAND,
        skillInstallCommand: AGENTLY_MAIL_SKILL_INSTALL_COMMAND,
      };
    }
  }

  async verify() {
    try {
      const { stdout, stderr } = await this.execFileImpl(AGENTLY_MAIL_CLI, ["+me"], {
        cwd: this.cwd,
        env: this.env,
        timeout: VERIFY_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      });
      const raw = `${textFrom(stdout)}\n${textFrom(stderr)}`;
      const email = parseAgentlyMailAddress(raw);
      if (!email) {
        return { ok: false, error: "mailbox_not_found", raw };
      }
      return { ok: true, email, raw };
    } catch (err) {
      const raw = `${textFrom((err as any)?.stdout)}\n${textFrom((err as any)?.stderr)}`;
      return { ok: false, error: normalizeError(err), raw };
    }
  }

  async startAuthLogin() {
    const backend = await this.ptyBackendFactory();
    return new Promise<{ authUrl: string; prompt: string; raw: string }>((resolve, reject) => {
      let settled = false;
      let raw = "";
      let proc: { kill?: () => void } | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          try { proc?.kill?.(); } catch {}
          reject(new Error("agently_mail_auth_url_timeout"));
        });
      }, AUTH_TIMEOUT_MS);
      timer.unref?.();

      try {
        proc = backend.spawn({
          command: "agently-cli auth login",
          cwd: this.cwd,
          cols: 120,
          rows: 30,
          env: this.env,
          onData: (data) => {
            raw += String(data || "");
            const authUrl = parseAgentlyMailAuthUrl(raw);
            if (!authUrl) return;
            finish(() => resolve({ authUrl, prompt: AUTH_PROMPT, raw }));
          },
          onExit: (event) => {
            if (settled) return;
            const authUrl = parseAgentlyMailAuthUrl(raw);
            finish(() => {
              if (authUrl) {
                resolve({ authUrl, prompt: AUTH_PROMPT, raw });
              } else {
                reject(new Error(`agently_mail_auth_login_exited:${event?.exitCode ?? "unknown"}`));
              }
            });
          },
        });
      } catch (err) {
        finish(() => reject(err));
      }
    });
  }
}

export function createAgentlyMailAdapter({ email, agentId, onStatus }: {
  email?: string | null;
  agentId?: string | null;
  onStatus?: (status: string, error?: string | null, errorType?: string | null, detail?: unknown) => void;
} = {}) {
  const mailbox = String(email || "").trim();
  queueMicrotask(() => {
    if (mailbox) onStatus?.("connected", null, null, { email: mailbox, adapterVersion: "agently-mail-cli" });
  });
  return {
    adapterVersion: "agently-mail-cli",
    capabilities: {
      receive: true,
      reply: true,
      proactive: true,
      email: true,
      media: true,
    },
    mediaCapabilities: AGENTLY_MAIL_MEDIA_CAPABILITIES,
    getStatus() {
      return {
        platform: AGENTLY_MAIL_PLATFORM,
        agentId: agentId || null,
        adapterVersion: "agently-mail-cli",
        status: mailbox ? "connected" : "disconnected",
        authenticated: !!mailbox,
        email: mailbox,
      };
    },
    stop() {},
  };
}

export const defaultAgentlyMailCliService = new AgentlyMailCliService();
