import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function extractMacro(source, name) {
  const match = source.match(new RegExp(`!macro ${name}(?:\\s|$)[\\s\\S]*?!macroend`));
  return match?.[0] || "";
}

describe("Windows NSIS installer contract", () => {
  it("uses the Codia product identity while preserving the managed Windows install root", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

    expect(pkg.build.appId).toBe("cn.edu.njust.byoung");
    expect(pkg.build.productName).toBe("Codia");
    expect(pkg.build.win.executableName).toBe("Codia");
    expect(pkg.build.nsis.shortcutName).toBe("Codia");
    expect(pkg.build.nsis.createDesktopShortcut).toBe(true);
    expect(pkg.build.nsis.createStartMenuShortcut).toBe(true);
    expect(pkg.build.nsis.guid).toBe("ed42e0a7-d7b7-59de-b48f-420bf3932f92");
    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(false);
  });

  it("removes legacy branded shortcuts before creating the Codia shortcut", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const cleanup = extractMacro(source, "gsapRemoveLegacyShortcuts");
    const customInstall = extractMacro(source, "customInstall");

    expect(cleanup).toContain('Delete "$DESKTOP\\G-SAP.lnk"');
    expect(cleanup).toContain('Delete "$SMPROGRAMS\\G-SAP.lnk"');
    expect(cleanup).toContain(
      'Delete "$DESKTOP\\G-SAP星河智域专业版0.001.0.lnk"',
    );
    expect(cleanup).toContain(
      'Delete "$SMPROGRAMS\\G-SAP星河智域专业版0.001.0.lnk"',
    );
    expect(customInstall).toContain("gsapRemoveLegacyShortcuts");
  });

  it("prepares an app-owned overlay when the previous uninstaller cannot be trusted", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const uninstallCheck = extractMacro(source, "customUnInstallCheck");
    const updaterBypass = extractMacro(source, "gsapBypassOldUninstallerForUpdate");

    expect(uninstallCheck).toContain("gsapPrepareOwnedOverlay");
    expect(uninstallCheck).not.toContain("Quit");
    expect(updaterBypass).toContain("${isUpdated}");
    expect(updaterBypass).toContain("gsapPrepareOwnedOverlay");
  });

  it("cleans generated install surfaces and install-directory owned processes before overlaying files", () => {
    const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf-8");
    const removeTrees = extractMacro(source, "gsapRemoveOwnedInstallTrees");
    const cleaner = extractMacro(source, "gsapWriteInstallDirProcessCleaner");

    expect(removeTrees).toContain('RMDir /r "$INSTDIR\\resources\\server"');
    expect(removeTrees).toContain('RMDir /r "$INSTDIR\\resources\\app"');
    expect(removeTrees).toContain('Delete "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(cleaner).toContain("Get-CimInstance Win32_Process");
    expect(cleaner).toContain("CommandLine");
    expect(cleaner).toContain("Stop-Process");
    expect(cleaner).toContain("$$_.ProcessId -ne $$installerPid");
  });
});
