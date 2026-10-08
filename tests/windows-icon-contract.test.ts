import { describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const root = process.cwd();

function readIcoSizes(filePath) {
  const data = fs.readFileSync(filePath);
  const count = data.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    sizes.push(data[offset] === 0 ? 256 : data[offset]);
  }
  return sizes;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("Windows icon contract", () => {
  it("uses the app ICO for Windows packaging and installer surfaces", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.build.win.icon).toBe("desktop/src/icon.ico");
    expect(pkg.build.nsis.installerIcon).toBe("desktop/src/icon.ico");
    expect(pkg.build.nsis.uninstallerIcon).toBe("desktop/src/icon.ico");
    expect(pkg.build.files).toContain("desktop/src/**/*.{html,icns,ico,png,svg,json}");
    expect(pkg.scripts["build:win-release-resources"]).toContain("npm run generate:professional-icon");
    expect(pkg.scripts["dist:win"]).toContain("npm run build:win-release-resources");
  });

  it("keeps the Windows taskbar identity stable across installer and portable builds", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(main).toContain(`const APP_USER_MODEL_ID = "${pkg.build.appId}"`);
    expect(main).toContain("app.setAppUserModelId(runtimeAppUserModelId())");
    expect(main).toContain("return APP_USER_MODEL_ID;");
    expect(main).not.toContain("GSAP_IDE_APP_USER_MODEL_ID");
    expect(main).not.toContain("gsap-ide");
    expect(main).not.toMatch(/hana-ide|hanaide|HanaIDE/);
    expect(main).not.toMatch(/runtimeAppUserModelId[\s\S]*?\.portable/);
  });

  it("uses Codia branding for the runtime window title", () => {
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(main).toContain('const RUNTIME_DISPLAY_NAME = "Codia"');
    expect(main).toContain("function runtimeProductName()");
    expect(main).toContain("return RUNTIME_DISPLAY_NAME;");
    expect(main).not.toContain('"G-SAP IDE"');
  });

  it("uses the Codia app icon and display name for the Windows tray hover surface", () => {
    const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");

    expect(main).toContain('const RUNTIME_DISPLAY_NAME = "Codia"');
    expect(main).toContain("function runtimeDisplayName()");
    expect(main).toContain("function resolveTrayIconPath()");
    expect(main).toContain("icon = nativeImage.createFromPath(resolveTrayIconPath())");
    expect(main).toContain("tray.setToolTip(isDev ? `${runtimeDisplayName()} (dev)` : runtimeDisplayName())");
  });

  it("uses kskooo as the Windows installer publisher metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.author.name).toBe("kskooo");
    expect(pkg.build.win.signtoolOptions.publisherName).toBe("kskooo");
    expect(pkg.build.win.certificateSubjectName).toBeUndefined();
  });

  it("ships a square app icon suitable for the taskbar and generated ICO", () => {
    const iconPng = PNG.sync.read(fs.readFileSync(path.join(root, "desktop", "src", "icon.png")));
    expect(iconPng.width).toBe(512);
    expect(iconPng.height).toBe(512);

    const icoSizes = readIcoSizes(path.join(root, "desktop", "src", "icon.ico"));
    expect(icoSizes).toEqual([256, 128, 64, 48, 32, 24, 16]);
  });

  it("keeps all runtime app icon surfaces generated from the same source mark", () => {
    const iconPngPath = path.join(root, "desktop", "src", "icon.png");
    const iconHash = sha256(iconPngPath);

    for (const relativePath of [
      path.join("desktop", "src", "assets", "codia", "codia-brand-emblem.png"),
      path.join("desktop", "src", "assets", "G-SAP.png"),
      path.join("desktop", "src", "assets", "about-icon.png"),
    ]) {
      expect(sha256(path.join(root, relativePath))).toBe(iconHash);
    }

    const iconIcoPath = path.join(root, "desktop", "src", "icon.ico");
    const iconIcoHash = sha256(iconIcoPath);
    for (const relativePath of [
      path.join("desktop", "src", "tray.ico"),
      path.join("desktop", "src", "tray-dev.ico"),
      path.join("desktop", "src", "assets", "tray.ico"),
      path.join("desktop", "src", "assets", "tray-dev.ico"),
    ]) {
      expect(sha256(path.join(root, relativePath))).toBe(iconIcoHash);
      expect(readIcoSizes(path.join(root, relativePath))).toEqual([256, 128, 64, 48, 32, 24, 16]);
    }

    const trayPngs: Array<[string, number]> = [
      [path.join("desktop", "src", "assets", "tray-template.png"), 16],
      [path.join("desktop", "src", "assets", "tray-dev-template.png"), 16],
      [path.join("desktop", "src", "assets", "tray-template@2x.png"), 32],
      [path.join("desktop", "src", "assets", "tray-dev-template@2x.png"), 32],
    ];
    for (const [relativePath, size] of trayPngs) {
      const trayPng = PNG.sync.read(fs.readFileSync(path.join(root, relativePath)));
      expect(trayPng.width).toBe(size);
      expect(trayPng.height).toBe(size);
    }

    const icns = fs.readFileSync(path.join(root, "desktop", "src", "icon.icns"));
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.length).toBeGreaterThan(1024);
  });

  it("uses Codia process names while retaining legacy upgrade cleanup hooks", () => {
    const installer = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");

    expect(installer).toContain("Codia.exe");
    expect(installer).toContain("BYOUNG.exe");
    expect(installer).toContain("G-SAP星河智域专业版0.001.0.exe");
    expect(installer).toContain("gsap-server.exe");
    expect(installer).toContain("GSAP_INSTALL_DIR");
    expect(installer).toContain('RMDir /r "$INSTDIR\\resources\\app"');
    const visibleInstallerCopy = installer
      .split(/\r?\n/u)
      .filter(line => /\bDetailPrint\b|\bMessageBox\b/u.test(line))
      .join("\n");
    expect(visibleInstallerCopy).not.toMatch(/G-SAP|GSAP|星河智域/u);
    expect(installer).not.toMatch(/Hanako|Hana-owned|hana-server\.exe|HANA_INSTALL_DIR/);
  });
});
