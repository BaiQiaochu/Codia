/**
 * desk-manager.js -Desk 目录管理
 *
  *
  * */

import fs from "fs";
import path from "path";

/**
 * 创建 Desk 管理- * @param {string} deskDir - desk 目录路径（{agentDir}/desk/- */
export function createDeskManager(deskDir) {
  const runsDir = path.join(deskDir, "cron-runs");

  return {
 /** desk 目录路径 */
    deskDir,

    /**
 * 确保 desk 目录结构存在
     */
    ensureDir() {
      fs.mkdirSync(deskDir, { recursive: true });
      fs.mkdirSync(runsDir, { recursive: true });
    },
  };
}
