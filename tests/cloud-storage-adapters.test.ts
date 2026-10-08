import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalObjectStore, ObjectAlreadyExistsError, S3ObjectStore,
  s3ObjectUrl, signS3Request, validateObjectKey,
} from "../lib/cloud-workspace/object-store.ts";
import { PostgresWorkspaceDatabase } from "../lib/cloud-workspace/postgres.ts";
import type { PgPoolClient, PgQueryable, PgQueryResult } from "../lib/cloud-workspace/postgres.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const checksum = (value: Buffer | string) => createHash("sha256").update(value).digest("base64");
// Public AWS documentation test credentials, never an actual account secret.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = () => new Date("2013-05-24T00:00:00Z");
const configuration = { ...credentials, endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "examplebucket", region: "us-east-1", now };
const directories: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codia-object-test-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local immutable object storage", () => {
  it("persists and verifies binary and empty bytes across store instances", async () => {
    const root = await temporaryRoot();
    const store = new LocalObjectStore(root);
    const bytes = Buffer.from([0, 255, 14, 10, 128]);
    expect(await store.putImmutable("tenant/workspace/report.bin", bytes)).toEqual({ size: bytes.length, sha256: hash(bytes) });
    expect(await new LocalObjectStore(root).get("tenant/workspace/report.bin")).toEqual(bytes);
    expect(await store.putImmutable("empty", Buffer.alloc(0))).toEqual({ size: 0, sha256: hash("") });
    expect(await store.get("empty")).toEqual(Buffer.alloc(0));
    expect((await readdir(root)).every((filename) => /^[a-f0-9]{64}\.object$/.test(filename))).toBe(true);
  });

  it("never overwrites existing bytes, even for concurrent writers", async () => {
    const root = await temporaryRoot();
    const stores = [new LocalObjectStore(root), new LocalObjectStore(root)];
    const results = await Promise.allSettled(stores.map((store, index) => store.putImmutable("same", Buffer.from(String(index)))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ObjectAlreadyExistsError);
    const bytes = await stores[0].get("same");
    await expect(stores[0].putImmutable("same", bytes)).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
    expect(await stores[0].get("same")).toEqual(bytes);
  });

  it("copies caller data before awaiting filesystem work", async () => {
    const store = new LocalObjectStore(await temporaryRoot());
    const input = Buffer.from("original");
    const pending = store.putImmutable("key", input);
    input.fill(0);
    await pending;
    expect(await store.get("key")).toEqual(Buffer.from("original"));
  });

  it("detects corrupted body/metadata instead of delivering altered content", async () => {
    const root = await temporaryRoot();
    const store = new LocalObjectStore(root);
    await store.putImmutable("key", Buffer.from("original"));
    const filename = path.join(root, `${hash("key")}.object`);
    const bytes = await readFile(filename);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(filename, bytes);
    await expect(store.get("key")).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("refuses object-file symlinks and reports missing objects", async () => {
    const root = await temporaryRoot();
    const store = new LocalObjectStore(root);
    await expect(store.get("missing")).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await symlink(path.join(root, "missing"), path.join(root, `${hash("link")}.object`));
    await expect(store.get("link")).rejects.toBeDefined();
  });

  it.each(["", "/etc/passwd", "../escape", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\0b", "a/%2e%2e/b", "a/%2fb", "a/%5cb", "e\u0301", "\ud800"])("refuses unsafe key %j before IO", async (key) => {
    expect(() => validateObjectKey(key)).toThrow();
    const store = new LocalObjectStore(await temporaryRoot());
    await expect(store.putImmutable(key, Buffer.from("x"))).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(store.get(key)).rejects.toMatchObject({ code: "INVALID_KEY" });
  });
});

describe("S3 adapter contract (fake HTTP, no live provider)", () => {
  it("matches AWS's published single-chunk PUT signature vector", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    const result = signS3Request({
      method: "PUT", url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      region: "us-east-1", credentials, now: now(), payloadSha256: hash("Welcome to Amazon S3."),
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    });
    expect(hash(result.canonicalRequest)).toBe("9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d");
    expect(result.headers.authorization).toContain("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("canonicalizes spaces, Unicode, literal percent, reserved characters and separators once", () => {
    const url = s3ObjectUrl(configuration.endpoint, configuration.bucket, "tenant/报告 100% !'()*+$?#.txt");
    expect(url.pathname).toBe("/examplebucket/tenant/%E6%8A%A5%E5%91%8A%20100%25%20%21%27%28%29%2A%2B%24%3F%23.txt");
    const result = signS3Request({ method: "GET", url, region: "us-east-1", credentials, now: now(), payloadSha256: hash("") });
    expect(result.canonicalRequest.split("\n")[1]).toBe(url.pathname);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it("signs conditional upload, checksum and session token; validates roundtrip", async () => {
    const bytes = Buffer.from("hello 世界");
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("x-amz-security-token")).toBe("PUBLICEXAMPLETOKEN/+=");
      expect(headers.get("authorization")).toContain("x-amz-security-token");
      if (init?.method === "PUT") {
        expect(headers.get("if-none-match")).toBe("*");
        expect(headers.get("authorization")).toContain("if-none-match");
        expect(headers.get("x-amz-content-sha256")).toBe(hash(bytes));
        expect(headers.get("x-amz-checksum-sha256")).toBe(checksum(bytes));
        expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes);
        return new Response(null, { headers: { "x-amz-checksum-sha256": checksum(bytes) } });
      }
      expect(headers.get("x-amz-checksum-mode")).toBe("ENABLED");
      return new Response(bytes, { headers: { "x-amz-meta-sha256": hash(bytes), "x-amz-checksum-sha256": checksum(bytes) } });
    });
    const store = new S3ObjectStore({ ...configuration, sessionToken: "PUBLICEXAMPLETOKEN/+=", fetch: transport });
    expect(await store.putImmutable("tenant/version", bytes)).toEqual({ size: bytes.length, sha256: hash(bytes) });
    expect(await store.get("tenant/version")).toEqual(bytes);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store)).not.toContain(credentials.secretAccessKey);
  });

  it.each([[412, "OBJECT_EXISTS"], [409, "WRITE_CONFLICT"], [403, "STORAGE_ERROR"]])("does not retry or overwrite on HTTP %s", async (status, code) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("private response", { status: status as number }));
    const store = new S3ObjectStore({ ...configuration, fetch: transport });
    await expect(store.putImmutable("key", Buffer.from("x"))).rejects.toMatchObject({ code });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects upload response checksum mismatch", async () => {
    const store = new S3ObjectStore({ ...configuration, fetch: vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { headers: { "x-amz-checksum-sha256": checksum("wrong") } }),
    ) });
    await expect(store.putImmutable("key", Buffer.from("x"))).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it.each([
    {}, { "x-amz-meta-sha256": hash("wrong") },
    { "x-amz-meta-sha256": hash("x"), "x-amz-checksum-sha256": checksum("wrong") },
  ] as Record<string, string>[])("rejects missing or inconsistent download checksum metadata: %j", async (headers) => {
    const store = new S3ObjectStore({ ...configuration, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { headers })) });
    await expect(store.get("key")).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("bounds declared and streamed response bytes, and refuses oversized writes before transport", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("x", { headers: { "content-length": "5" } }));
    const store = new S3ObjectStore({ ...configuration, maxObjectBytes: 4, fetch: transport });
    await expect(store.get("declared-large")).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    transport.mockResolvedValue(new Response("12345", { headers: { "x-amz-meta-sha256": hash("12345") } }));
    await expect(store.get("streamed-large")).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    await expect(store.putImmutable("large", Buffer.from("12345"))).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(() => new S3ObjectStore({ ...configuration, maxObjectBytes: 0 })).toThrow();
  });

  it("redacts transport details and never follows redirect responses", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(`network failed: ${credentials.secretAccessKey}`));
    const store = new S3ObjectStore({ ...configuration, fetch: transport });
    await expect(store.get("key")).rejects.toMatchObject({ message: "Object storage request failed", code: "TRANSPORT_ERROR" });
    transport.mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.example" } }));
    await expect(store.get("key")).rejects.toMatchObject({ status: 307 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["http://example.com", "https://name:secret@example.com", "https://example.com/path", "https://example.com/?q=1"])("refuses unsafe endpoint %s without a request", (endpoint) => {
    const transport = vi.fn<typeof fetch>();
    expect(() => new S3ObjectStore({ ...configuration, endpoint, fetch: transport })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses unsafe keys and unbounded timeouts before making requests", async () => {
    const transport = vi.fn<typeof fetch>();
    const store = new S3ObjectStore({ ...configuration, fetch: transport });
    await expect(store.get("a/../b")).rejects.toMatchObject({ code: "INVALID_KEY" });
    expect(() => new S3ObjectStore({ ...configuration, timeoutMs: 15001 })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

function fakeDatabase(fail?: (sql: string) => boolean) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query: PgQueryable["query"] = async <Row extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PgQueryResult<Row>> => {
    calls.push({ sql, values });
    if (fail?.(sql)) throw new Error(`fake failure: ${sql}`);
    return { rows: [], rowCount: 0 };
  };
  const release = vi.fn();
  const client: PgPoolClient = { query, release };
  const connect = vi.fn(async () => client);
  return { database: new PostgresWorkspaceDatabase({ connect }), calls, release, connect };
}
const actor = { tenantId: "tenant-a", actorId: "owner-a" };

describe("PostgreSQL boundary contract (fake client, not RLS execution)", () => {
  it("sets parameterized transaction-local tenant/actor before caller SQL and commits", async () => {
    const { database, calls, release } = fakeDatabase();
    expect(await database.transaction(actor, async (tx) => { await tx.query("SELECT * FROM codia_cloud.workspaces"); return 42; })).toBe(42);
    expect(calls.map((call) => call.sql)).toEqual([
      "BEGIN", "SET LOCAL search_path = pg_catalog",
      "SELECT set_config('codia.tenant_id', $1, true), set_config('codia.actor_id', $2, true)",
      "SELECT set_config('codia.trusted_worker', 'off', true)",
      "SELECT * FROM codia_cloud.workspaces", "COMMIT",
    ]);
    expect(calls[2].values).toEqual(["tenant-a", "owner-a"]);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("rolls back and preserves a callback error", async () => {
    const { database, calls, release } = fakeDatabase();
    const error = new Error("business failure");
    await expect(database.transaction(actor, async () => { throw error; })).rejects.toBe(error);
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it.each(["BEGIN", "ROLLBACK"])("discards a client whose %s failed", async (failure) => {
    const { database, release } = fakeDatabase((sql) => sql === failure);
    await expect(database.transaction(actor, async () => { throw new Error("callback"); })).rejects.toThrow();
    expect(release).toHaveBeenCalledWith(true);
  });

  it.each(["SET LOCAL search_path = pg_catalog", "COMMIT"])("rolls back when %s fails", async (failure) => {
    const { database, calls, release } = fakeDatabase((sql) => sql === failure);
    await expect(database.transaction(actor, async () => "ok")).rejects.toThrow("fake failure");
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("validates before checkout, captures identity, and denies use after transaction", async () => {
    const { database, connect, calls } = fakeDatabase();
    await expect(database.transaction({ tenantId: "", actorId: "x" }, async () => {})).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    const context = { ...actor };
    let retained: PgQueryable | undefined;
    const pending = database.transaction(context, async (tx) => { retained = tx; });
    context.tenantId = "another-tenant";
    await pending;
    expect(calls[2].values).toEqual(["tenant-a", "owner-a"]);
    await expect(retained!.query("SELECT 1")).rejects.toThrow("no longer active");
  });

  it("includes fail-closed forced RLS, owner-aware foreign keys and immutable history in migration source", async () => {
    const sql = await readFile(new URL("../lib/cloud-workspace/migrations/001-cloud-workspaces.sql", import.meta.url), "utf8");
    for (const table of ["workspaces", "files", "file_versions", "runs", "run_events", "outbox"]) {
      expect(sql).toContain(`CREATE TABLE codia_cloud.${table}`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("WITH CHECK");
    expect(sql).toContain("codia.tenant_id");
    expect(sql).toContain("codia.actor_id");
    expect(sql).toContain("NULLIF(current_setting");
    expect(sql).toContain("FOREIGN KEY (tenant_id, owner_id, workspace_id, file_id)");
    expect(sql).toContain("immutable_file_versions BEFORE UPDATE OR DELETE");
    expect(sql).toContain("immutable_run_events BEFORE UPDATE OR DELETE");
    expect(sql).not.toMatch(/CREATE ROLE|CREATE USER|GRANT .* TO PUBLIC/i);
  });
});
