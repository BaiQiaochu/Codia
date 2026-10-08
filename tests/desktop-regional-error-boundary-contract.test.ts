import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("desktop regional error boundary contract", () => {
  it("does not render the old regional unavailable panel", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "desktop", "src", "react", "components", "RegionalErrorBoundary.tsx"),
      "utf-8",
    );

    expect(source).not.toContain("error.regionUnavailable");
    expect(source).not.toContain("action.retry");
    expect(source).not.toContain("此区域暂时无法显示");
    expect(source).not.toContain("This area is temporarily unavailable");
    expect(source).not.toContain("className={styles.fallback}");
    expect(source).not.toContain("handleRetry");
    expect(source).not.toContain("autoRetry");
    expect(source).not.toContain("scheduleAutoRetry");
    expect(source).toContain("return null;");
  });

  it("keeps the generic app error boundary available for top-level crashes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "desktop", "src", "react", "components", "ErrorBoundary.tsx"),
      "utf-8",
    );

    expect(source).toContain("ErrorBoundary");
    expect(source).toContain("handleRetry");
  });
});
