// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

describe("resource ticket service", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("issues and verifies a short-lived ticket bound to one resource", async () => {
    const {
      issueResourceTicket,
      verifyResourceTicket,
      resourceTicketKeyPath,
    } = await import("../core/resource-ticket-service.ts");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-resource-ticket-"));

    const issued = issueResourceTicket({
      hanakoHome: tmpDir,
      resourceId: "res_sf_1",
      studioId: "studio_1",
      principalId: "principal_device_1",
      now: "2026-05-17T00:00:00.000Z",
      ttlMs: 60_000,
    });

    expect(issued).toMatchObject({
      resourceId: "res_sf_1",
      studioId: "studio_1",
      principalId: "principal_device_1",
      expiresAt: "2026-05-17T00:01:00.000Z",
    });
    expect(issued.ticket).toEqual(expect.any(String));
    expect(fs.existsSync(resourceTicketKeyPath(tmpDir))).toBe(true);

    expect(verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: issued.ticket,
      resourceId: "res_sf_1",
      now: "2026-05-17T00:00:30.000Z",
    })).toMatchObject({
      resourceId: "res_sf_1",
      studioId: "studio_1",
      principalId: "principal_device_1",
      action: "resources.content",
    });

    expect(() => verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: issued.ticket,
      resourceId: "res_other",
      now: "2026-05-17T00:00:30.000Z",
    })).toThrow("resource ticket resource mismatch");

    expect(() => verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: issued.ticket,
      resourceId: "res_sf_1",
      now: "2026-05-17T00:02:00.000Z",
    })).toThrow("resource ticket expired");

    expect(() => verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: "not-a-valid-ticket",
      resourceId: "res_sf_1",
      now: "2026-05-17T00:00:30.000Z",
    })).toThrow("resource ticket malformed");

    const [body] = issued.ticket.split(".");
    expect(() => verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: `${body}.bad-signature`,
      resourceId: "res_sf_1",
      now: "2026-05-17T00:00:30.000Z",
    })).toThrow("resource ticket signature invalid");

    expect(() => verifyResourceTicket({
      hanakoHome: tmpDir,
      ticket: issued.ticket,
      resourceId: "res_sf_1",
      now: "not-a-date",
    })).toThrow("resource ticket timestamp invalid");
  });
});
