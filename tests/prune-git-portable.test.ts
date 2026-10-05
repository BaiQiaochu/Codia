import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { prunePortableGitRuntime } from "../scripts/prune-git-portable.js";

const silent = { log() {} };

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
}

// 模拟 PortableGit 解压产物的关键子集
function buildFakeRuntime(root) {
  // ── 必须保留 ──
  for (const keep of [
    "cmd/git.exe",
    "bin/bash.exe",
    "bin/sh.exe",
    "usr/bin/bash.exe",
    "usr/bin/msys-2.0.dll",
    "mingw64/bin/git.exe",
    "mingw64/bin/libcrypto-3-x64.dll",
    "usr/bin/grep.exe",
    "usr/bin/sed.exe",
    "usr/bin/gawk.exe",
    "usr/bin/cat.exe",
    "usr/bin/find.exe",
    "etc/profile",
    "etc/fstab",
    "mingw64/bin/ash.exe",
    "mingw64/bin/busybox.exe",
  ]) touch(path.join(root, keep));

  // ── 必须删除 ──
  for (const drop of [
    "mingw64/share/doc/git-doc/git.html",
    "usr/share/man/man1/git.1",
    "usr/share/info/dir",
    "usr/include/foo.h",
    "usr/lib/perl5/core_perl/Foo.pm",
    "usr/share/perl5/core_perl/Bar.pm",
    "mingw64/lib/perl5/Baz.pm",
    "mingw64/lib/tcl8.6/init.tcl",
    "mingw64/lib/tk8.6/tk.tcl",
    "mingw64/lib/itcl4.2/itcl.tcl",
    "mingw64/share/git-gui/lib/git-gui.tcl",
    "mingw64/share/gitk/lib/msgs/de.msg",
    "mingw64/share/gitweb/gitweb.cgi",
    "mingw64/share/locale/de/LC_MESSAGES/git.mo",
    "usr/share/locale/fr/LC_MESSAGES/coreutils.mo",
    "mingw64/lib/pkgconfig/zlib.pc",
    "mingw64/lib/cmake/foo/bar.cmake",
    "mingw64/share/aclocal/foo.m4",
    "usr/share/vim/vim91/syntax/c.vim",
    "usr/bin/perl.exe",
    "usr/bin/vim.exe",
    "usr/bin/vimdiff.exe",
    "usr/bin/nano.exe",
    "mingw64/bin/wish86.exe",
    "mingw64/bin/tclsh86.exe",
    "mingw64/bin/perl.exe",
    "mingw64/bin/svn.exe",
    "git-bash.exe",
    "git-cmd.exe",
    "cmd/git-gui.exe",
    "cmd/gitk.exe",
    "cmd/start-ssh-agent.cmd",
    "mingw64/libexec/git-core/git-svn",
    "mingw64/libexec/git-core/git-send-email",
    "mingw64/libexec/git-core/git-add--interactive",
    "mingw64/libexec/git-core/git-gui",
    "mingw64/libexec/git-core/gitk",
    "mingw64/libexec/git-core/git-cvsserver",
  ]) touch(path.join(root, drop));
}

describe("prune-git-portable", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-prune-"));
    buildFakeRuntime(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("删掉 doc/man/info/include/perl/tcl-tk/gui/svn/locale/编辑器/启动器", () => {
    prunePortableGitRuntime(root, { logger: silent });
    for (const gone of [
      "mingw64/share/doc/git-doc/git.html",
      "usr/share/man/man1/git.1",
      "usr/share/info/dir",
      "usr/include/foo.h",
      "usr/lib/perl5/core_perl/Foo.pm",
      "usr/share/perl5/core_perl/Bar.pm",
      "mingw64/lib/perl5/Baz.pm",
      "mingw64/lib/tcl8.6/init.tcl",
      "mingw64/lib/tk8.6/tk.tcl",
      "mingw64/lib/itcl4.2/itcl.tcl",
      "mingw64/share/git-gui/lib/git-gui.tcl",
      "mingw64/share/gitk/lib/msgs/de.msg",
      "mingw64/share/gitweb/gitweb.cgi",
      "mingw64/share/locale/de/LC_MESSAGES/git.mo",
      "usr/share/locale/fr/LC_MESSAGES/coreutils.mo",
      "mingw64/lib/pkgconfig/zlib.pc",
      "mingw64/lib/cmake/foo/bar.cmake",
      "mingw64/share/aclocal/foo.m4",
      "usr/share/vim/vim91/syntax/c.vim",
      "usr/bin/perl.exe",
      "usr/bin/vim.exe",
      "usr/bin/vimdiff.exe",
      "usr/bin/nano.exe",
      "mingw64/bin/wish86.exe",
      "mingw64/bin/tclsh86.exe",
      "mingw64/bin/perl.exe",
      "mingw64/bin/svn.exe",
      "git-bash.exe",
      "git-cmd.exe",
      "cmd/git-gui.exe",
      "cmd/gitk.exe",
      "cmd/start-ssh-agent.cmd",
      "mingw64/libexec/git-core/git-svn",
      "mingw64/libexec/git-core/git-send-email",
      "mingw64/libexec/git-core/git-add--interactive",
      "mingw64/libexec/git-core/git-gui",
      "mingw64/libexec/git-core/gitk",
      "mingw64/libexec/git-core/git-cvsserver",
    ]) {
      expect(fs.existsSync(path.join(root, gone)), `should remove ${gone}`).toBe(false);
    }
  });

  it("保留 git.exe / bash.exe / msys DLL / coreutils / etc / legacy shell", () => {
    prunePortableGitRuntime(root, { logger: silent });
    for (const kept of [
      "cmd/git.exe",
      "bin/bash.exe",
      "bin/sh.exe",
      "usr/bin/bash.exe",
      "usr/bin/msys-2.0.dll",
      "mingw64/bin/git.exe",
      "mingw64/bin/libcrypto-3-x64.dll",
      "usr/bin/grep.exe",
      "usr/bin/sed.exe",
      "usr/bin/gawk.exe",
      "usr/bin/cat.exe",
      "usr/bin/find.exe",
      "etc/profile",
      "etc/fstab",
      "mingw64/bin/ash.exe",
      "mingw64/bin/busybox.exe",
    ]) {
      expect(fs.existsSync(path.join(root, kept)), `should keep ${kept}`).toBe(true);
    }
  });

  it("dry-run 不真删，但报告将删除的文件数 > 0", () => {
    const stats = prunePortableGitRuntime(root, { dryRun: true, logger: silent });
    expect(fs.existsSync(path.join(root, "usr/bin/perl.exe"))).toBe(true);
    expect(fs.existsSync(path.join(root, "mingw64/share/doc/git-doc/git.html"))).toBe(true);
    expect(stats.removedFiles).toBeGreaterThan(0);
    expect(stats.removedDirs).toBeGreaterThan(0);
  });

  it("幂等：第二次运行无新增删除且不报错", () => {
    prunePortableGitRuntime(root, { logger: silent });
    const second = prunePortableGitRuntime(root, { logger: silent });
    expect(second.removedFiles).toBe(0);
    expect(second.removedDirs).toBe(0);
  });

  it("裁剪后缺失关键文件时抛错，不产出残缺 runtime", () => {
    fs.rmSync(path.join(root, "bin/bash.exe"));
    fs.rmSync(path.join(root, "usr/bin/bash.exe"));
    expect(() => prunePortableGitRuntime(root, { logger: silent }))
      .toThrow(/缺失关键文件/);
  });

  it("runtime root 不存在时抛错", () => {
    expect(() => prunePortableGitRuntime(path.join(root, "nope"), { logger: silent }))
      .toThrow(/runtime root not found/);
  });
});
