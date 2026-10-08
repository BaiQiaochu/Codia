import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export interface ObjectStore {
  readonly kind: string;
  putImmutable(key: string, bytes: Buffer): Promise<{ size: number; sha256: string }>;
  get(key: string): Promise<Buffer>;
}

export class ObjectStoreError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ObjectStoreError";
  }
}

export class ObjectAlreadyExistsError extends ObjectStoreError {
  constructor() {
    super("An immutable object already exists at this key", "OBJECT_EXISTS", 409);
    this.name = "ObjectAlreadyExistsError";
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Keys are logical identifiers, never OS paths or pre-encoded URLs. */
export function validateObjectKey(key: string): void {
  if (typeof key !== "string" || !key || Buffer.byteLength(key, "utf8") > 1024 ||
      (key.includes("\\") || hasControlCharacters(key)) || key !== key.normalize("NFC")) {
    throw new ObjectStoreError("Invalid object key", "INVALID_KEY");
  }
  for (const segment of key.split("/")) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* Literal percent characters are encoded on the wire. */ }
    if (!segment || segment === "." || segment === ".." || decoded === "." || decoded === ".." ||
        (decoded.includes("/") || decoded.includes("\\") || hasControlCharacters(decoded))) {
      throw new ObjectStoreError("Invalid object key", "INVALID_KEY");
    }
  }
  // Reject lone surrogates instead of allowing UTF-8 replacement to alias another key.
  try { encodeURIComponent(key); } catch {
    throw new ObjectStoreError("Invalid object key", "INVALID_KEY");
  }
}

const LOCAL_MAGIC = "CODIA_OBJECT_V1";
// Matches the largest explicitly permitted legacy migration input.
export const MAX_CLOUD_OBJECT_BYTES = 32 * 1024 * 1024;
function checkObjectSize(size: number, maximum = MAX_CLOUD_OBJECT_BYTES) {
  if (size > maximum) throw new ObjectStoreError("Object exceeds the storage size limit", "OBJECT_TOO_LARGE", 413);
}

/** Durable local development storage; this is not a hosted object service. */
export class LocalObjectStore implements ObjectStore {
  readonly kind = "local";
  readonly #root: string;
  #ready?: Promise<void>;

  constructor(rootDir: string) {
    if (!rootDir) throw new ObjectStoreError("Object root is required", "INVALID_CONFIG");
    this.#root = path.resolve(rootDir);
  }

  async #prepare(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.#root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ObjectStoreError("Object root must be a directory, not a symlink", "INVALID_CONFIG");
      }
    })();
    return this.#ready;
  }

  #filename(key: string): string {
    validateObjectKey(key);
    // Raw keys never enter filesystem paths, including Windows reserved names.
    return path.join(this.#root, `${sha256(key)}.object`);
  }

  async putImmutable(key: string, input: Buffer): Promise<{ size: number; sha256: string }> {
    const filename = this.#filename(key);
    checkObjectSize(input.length);
    const bytes = Buffer.from(input); // Caller mutation must not change a signed/persisted payload.
    const digest = sha256(bytes);
    await this.#prepare();
    const temp = path.join(this.#root, `.pending-${randomUUID()}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.concat([
        Buffer.from(`${LOCAL_MAGIC} ${digest} ${bytes.length}\n`, "ascii"), bytes,
      ]));
      await handle.sync();
      await handle.close();
      try {
        // A hard link publishes a complete file atomically and fails if the key exists.
        // rename() is intentionally not used: it would overwrite on POSIX.
        await link(temp, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ObjectAlreadyExistsError();
        throw error;
      }
      // Persist the directory entry before reporting success (POSIX cloud runtime).
      const directory = await open(this.#root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return { size: bytes.length, sha256: digest };
    } finally {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }

  async get(key: string): Promise<Buffer> {
    const filename = this.#filename(key);
    await this.#prepare();
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectStoreError("Object not found", "OBJECT_NOT_FOUND", 404);
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ObjectStoreError("Invalid stored object", "INTEGRITY_ERROR");
      checkObjectSize(stat.size, MAX_CLOUD_OBJECT_BYTES + 128);
      const envelope = await handle.readFile();
      const end = envelope.indexOf(10);
      const header = envelope.subarray(0, end).toString("ascii");
      const match = /^CODIA_OBJECT_V1 ([a-f0-9]{64}) (0|[1-9][0-9]*)$/.exec(header);
      const bytes = envelope.subarray(end + 1);
      checkObjectSize(bytes.length);
      if (end < 0 || end > 128 || !match || Number(match[2]) !== bytes.length || sha256(bytes) !== match[1]) {
        throw new ObjectStoreError("Stored object failed SHA-256 integrity verification", "INTEGRITY_ERROR");
      }
      return Buffer.from(bytes);
    } finally {
      await handle.close();
    }
  }
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ObjectStoreOptions extends S3Credentials {
  /** Origin only, e.g. https://s3.us-east-1.amazonaws.com. No bucket/path/query. */
  endpoint: string;
  bucket: string;
  region: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Bounded reads/writes; cannot exceed the 32 MiB migration ceiling. */
  maxObjectBytes?: number;
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function s3ObjectUrl(endpoint: string, bucket: string, key: string): URL {
  validateObjectKey(key);
  let url: URL;
  try { url = new URL(endpoint); } catch {
    throw new ObjectStoreError("Invalid S3 endpoint", "INVALID_CONFIG");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ObjectStoreError("S3 endpoint must be an HTTPS origin without credentials, path or query", "INVALID_CONFIG");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new ObjectStoreError("Invalid S3 bucket name", "INVALID_CONFIG");
  }
  url.pathname = `/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
  return url;
}

/** Pure SigV4 signer for S3 requests. Never log its result: it contains authorization. */
export function signS3Request(options: {
  method: "GET" | "PUT";
  url: URL;
  region: string;
  credentials: S3Credentials;
  now: Date;
  payloadSha256: string;
  headers?: Record<string, string>;
}): { headers: Record<string, string>; canonicalRequest: string } {
  const { credentials, region, url, now, method, payloadSha256 } = options;
  if (!/^[a-z0-9-]+$/.test(region) || !/^[A-Za-z0-9]+$/.test(credentials.accessKeyId) ||
      !credentials.secretAccessKey || (credentials.sessionToken !== undefined &&
      (!credentials.sessionToken || (/\s/u.test(credentials.sessionToken) || hasControlCharacters(credentials.sessionToken)))) ||
      !/^[a-f0-9]{64}$/.test(payloadSha256) || !Number.isFinite(now.getTime()) ||
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ObjectStoreError("Invalid S3 signing configuration", "INVALID_CONFIG");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!/^[a-z0-9-]+$/i.test(name) || hasControlCharacters(value) || name.toLowerCase() === "authorization") {
      throw new ObjectStoreError("Invalid signing header", "INVALID_CONFIG");
    }
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  headers.host = url.host;
  headers["x-amz-date"] = timestamp;
  headers["x-amz-content-sha256"] = payloadSha256;
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method, url.pathname, "", names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders, payloadSha256,
  ].join("\n");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), "s3"), "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest };
}

/** S3 general-purpose/path-style API. No credential lookup, provisioning, or fallback. */
export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3";
  readonly #options: S3ObjectStoreOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: S3ObjectStoreOptions) {
    // Eager validation, without making a network request.
    const url = s3ObjectUrl(options.endpoint, options.bucket, "config-check");
    signS3Request({ method: "GET", url, region: options.region, credentials: options,
      now: new Date(), payloadSha256: sha256("") });
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 15_000)) {
      throw new ObjectStoreError("S3 timeout must be an integer between 1 and 15000 milliseconds", "INVALID_CONFIG");
    }
    if (options.maxObjectBytes !== undefined && (!Number.isSafeInteger(options.maxObjectBytes) || options.maxObjectBytes < 1 || options.maxObjectBytes > MAX_CLOUD_OBJECT_BYTES)) {
      throw new ObjectStoreError("Invalid object storage size limit", "INVALID_CONFIG");
    }
    this.#options = { ...options };
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #request(method: "GET" | "PUT", key: string, bytes?: Buffer): Promise<Response> {
    const url = s3ObjectUrl(this.#options.endpoint, this.#options.bucket, key);
    const digest = sha256(bytes ?? "");
    const headers: Record<string, string> = method === "PUT" ? {
      "content-type": "application/octet-stream",
      "if-none-match": "*",
      "x-amz-checksum-sha256": Buffer.from(digest, "hex").toString("base64"),
      "x-amz-meta-sha256": digest,
    } : { "x-amz-checksum-mode": "ENABLED" };
    const signed = signS3Request({ method, url, region: this.#options.region,
      credentials: this.#options, now: this.#options.now?.() ?? new Date(), payloadSha256: digest, headers });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method, headers: signed.headers, redirect: "error",
        body: bytes ? new Uint8Array(bytes) : undefined,
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000),
      });
    } catch {
      // Transport exceptions can contain credentials or URLs; do not propagate them.
      throw new ObjectStoreError("Object storage request failed", "TRANSPORT_ERROR");
    }
    if (method === "PUT" && response.status === 412) {
      await response.body?.cancel().catch(() => {});
      throw new ObjectAlreadyExistsError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ObjectStoreError(
        response.status === 404 ? "Object not found" : `Object storage returned HTTP ${response.status}`,
        response.status === 404 ? "OBJECT_NOT_FOUND" : response.status === 409 ? "WRITE_CONFLICT" : "STORAGE_ERROR",
        response.status,
      );
    }
    return response;
  }

  async putImmutable(key: string, input: Buffer): Promise<{ size: number; sha256: string }> {
    checkObjectSize(input.length, this.#options.maxObjectBytes);
    const bytes = Buffer.from(input);
    const digest = sha256(bytes);
    const response = await this.#request("PUT", key, bytes);
    const checksum = response.headers.get("x-amz-checksum-sha256");
    await response.body?.cancel().catch(() => {});
    if (checksum && checksum !== Buffer.from(digest, "hex").toString("base64")) {
      throw new ObjectStoreError("Uploaded object checksum did not match", "INTEGRITY_ERROR");
    }
    return { size: bytes.length, sha256: digest };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#request("GET", key);
    const maximum = this.#options.maxObjectBytes ?? MAX_CLOUD_OBJECT_BYTES;
    let bytes: Buffer;
    try {
      checkObjectSize(Number(response.headers.get("content-length") ?? 0), maximum);
      const chunks: Buffer[] = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.length; checkObjectSize(size, maximum);
            chunks.push(Buffer.from(part.value));
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError("Object storage response could not be read", "TRANSPORT_ERROR");
    }
    const digest = sha256(bytes);
    const metadata = response.headers.get("x-amz-meta-sha256");
    const checksum = response.headers.get("x-amz-checksum-sha256");
    if (metadata !== digest || (checksum && checksum !== Buffer.from(digest, "hex").toString("base64"))) {
      throw new ObjectStoreError("Downloaded object failed SHA-256 integrity verification", "INTEGRITY_ERROR");
    }
    return bytes;
  }
}
