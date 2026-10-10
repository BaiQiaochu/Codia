import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareBundledFfmpeg } from "../scripts/prepare-ffmpeg-portable.mjs";

describe("prepare bundled ffmpeg", () => {
  const previous = process.env.CODIA_SKIP_BUNDLED_FFMPEG;
  const tempDirs = [];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CODIA_SKIP_BUNDLED_FFMPEG;
    } else {
      process.env.CODIA_SKIP_BUNDLED_FFMPEG = previous;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-ffmpeg-test-"));
    tempDirs.push(root);
    return {
      rootDir: path.join(root, "root"),
      outDir: path.join(root, "out"),
    };
  }

  it("skips network download when CODIA_SKIP_BUNDLED_FFMPEG is enabled", () => {
    process.env.CODIA_SKIP_BUNDLED_FFMPEG = "1";
    const { rootDir, outDir } = makeTempRoot();

    const result = prepareBundledFfmpeg({ rootDir, outDir, platform: "win32" });

    expect(result).toEqual({ prepared: false, reason: "skipped-by-env" });
    expect(fs.existsSync(path.join(rootDir, "vendor", "ffmpeg-portable"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "ffmpeg"))).toBe(false);
  });
});
