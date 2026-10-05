const fs = require("fs");
const path = require("path");

const AVATAR_EXTS = ["png", "jpg", "jpeg", "webp"];

function isSafeAgentId(agentId) {
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    !agentId.includes("..") &&
    !agentId.includes("/") &&
    !agentId.includes("\\")
  );
}

function resolveAgentAvatarPath(gsapHome, agentId) {
  if (typeof gsapHome !== "string" || gsapHome.length === 0) return null;
  if (!isSafeAgentId(agentId)) return null;

  const avatarDir = path.join(gsapHome, "agents", agentId, "avatars");
  for (const ext of AVATAR_EXTS) {
    const candidate = path.join(avatarDir, `agent.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveAgentAvatarPath, AVATAR_EXTS };
