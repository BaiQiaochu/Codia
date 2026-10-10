import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable semantic version is required');
const directory = path.resolve(process.argv[2] || 'artifacts');
const required = [
  `Codia-${version}-Windows-x64.exe`,
  // electron-builder uses Debian's architecture name in the .deb artifact.
  `Codia-${version}-Linux-amd64.deb`,
  ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `Codia-${version}-macOS-${arch}.${ext}`)),
  'latest.yml', 'latest-mac.yml',
];
for (const name of required) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing release file: ${name}`);
}
const names = fs.readdirSync(directory).filter(name => /\.(exe|deb|dmg|zip|blockmap|yml|AppImage)$/.test(name)).sort();
const checksums = [];
for (const name of names) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
fs.writeFileSync(path.join(directory, 'RELEASE-NOTES.md'), `# Codia ${version}

本次安装包由 GitHub Actions 从同一提交构建，保留源码中的版本号。

- Windows x64：下载 .exe 安装程序。
- Linux x64：下载 .deb 软件包。
- macOS Apple Silicon：下载 arm64.dmg；Intel：下载 x64.dmg。
- ZIP 和 latest*.yml 用于 macOS 更新；SHA256SUMS.txt 可核对下载文件。
包含新版雾紫图标、Live2D 欢迎动画、显式会话视图切换、桌面窗口显示和会话完成时序修复。

签名说明：Windows 安装包未配置商业代码签名证书；macOS 使用 ad-hoc 签名，未经过 Apple Developer ID 签名和公证，首次打开可能受到系统安全提示。此版本不声称已通过 Windows/macOS 签名认证。

源码开发仍可使用 npm start；本地修改后可运行 npm run start:local 重新编译并启动。发布流程不会修改本地开发环境。
`);
console.log(`Prepared ${names.length} release files and SHA-256 checksums for v${version}`);
