import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

function readRoot(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("Codia README contract", () => {
  it("documents source startup, optional builds, local environment preservation, and licensing", () => {
    const readme = readRoot("README.md");

    expect(readme).toContain("<h1 align=\"center\">Codia · 小豆蔻</h1>");
    for (const heading of ['从源码运行', '主要能力', '常用开发命令', '目录', '文档与来源']) {
      expect(readme).toContain(`## ${heading}`);
    }
    expect(readme).toContain('Node.js >=24.12.0 <25');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm start');
    expect(readme).toContain('无需先执行 build 命令');
    expect(readme).toContain('build:client');
    expect(readme).toContain('build:server');
    expect(readme).toContain('Agent 小队');
    expect(readme).toContain("工作流");
    expect(readme).toContain('Live2D 等第三方组件保留各自许可');
    expect(readme).toContain('third_party/live2d/cubism-web-5-r.5/LICENSE.md');
    expect(readme).toContain('third_party/live2d/cubism-web-5-r.5/NOTICE.md');
    expect(readme).toContain('npm run start:local');
    expect(readme).toContain('npm run check:local');
    expect(readme).toContain('默认保留检查产物');
  });
});
