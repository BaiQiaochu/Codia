const fs = require("fs");
const path = require("path");

const outputArg = process.argv[2];
const distDir = outputArg
  ? path.resolve(path.join(__dirname, ".."), outputArg)
  : path.join(__dirname, "..", "dist");
if (!fs.existsSync(distDir)) process.exit(0);

for (const entry of fs.readdirSync(distDir)) {
  if (entry === "latest.yml" || entry.endsWith(".blockmap")) {
    try {
      fs.rmSync(path.join(distDir, entry), { force: true });
      console.log(`[cleanup-update-artifacts] removed ${entry}`);
    } catch (err) {
      console.warn(`[cleanup-update-artifacts] failed to remove ${entry}: ${err.message}`);
    }
  }
}
