// @ts-nocheck
function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import {
  listAgentPhoneProjectionFiles,
  readAgentPhoneProjection,
} from "../lib/conversations/agent-phone-projection.ts";
import { shouldRunFreshCompact } from "../lib/fresh-compact/policy.ts";
import { freshCompactAgentPhoneSession } from "./agent-executor.ts";

export class FreshCompactMaintainer {
  constructor({ hub, delayBetweenJobsMs = 5_000 } = {}) {
    this._hub = hub;
    this._delayBetweenJobsMs = delayBetweenJobsMs;
    this._running = false;
  }

  get _engine() { return this._hub.engine; }

  _listAgents() {
    const agents = this._engine.agents;
    if (agents instanceof Map) return [...agents.values()].filter(Boolean);
    if (Array.isArray(agents)) return agents.filter(Boolean);
    return [];
  }

  async runDaily({ now = new Date() } = {}) {
    if (this._running) return { retry: true, staleRemaining: 1 };
    this._running = true;
    const result = {
      bridgeCompacted: 0,
      phoneCompacted: 0,
      failed: 0,
      staleRemaining: 0,
    };

    try {
      for (const agent of this._listAgents()) {
        const bridgeTargets = this._engine.bridgeSessionManager
          ?.listDailyFreshCompactTargets?.(agent, { now }) || [];
        for (const target of bridgeTargets) {
          try {
            const alreadySatisfied = this._engine.bridgeSessionManager
              ?.isFreshCompactAlreadySatisfied?.(target.sessionKey, {
                agentId: agent.id,
                sessionPath: target.sessionPath,
              });
            if (alreadySatisfied?.satisfied) {
              await this._engine.bridgeSessionManager.markFreshCompactSatisfied(target.sessionKey, {
                agentId: agent.id,
                reason: "daily",
                now,
                noopReason: alreadySatisfied.reason,
              });
              result.bridgeCompacted += 1;
              await sleep(this._delayBetweenJobsMs);
              continue;
            }
            if (target.sessionPath && typeof agent.memoryTicker?.flushSessionAndCompile === "function") {
              await agent.memoryTicker.flushSessionAndCompile(target.sessionPath);
            }
            await this._engine.bridgeSessionManager.freshCompactSession(target.sessionKey, {
              agentId: agent.id,
              reason: "daily",
              now,
            });
            result.bridgeCompacted += 1;
          } catch (err) {
            result.failed += 1;
            result.staleRemaining += 1;
            console.warn(`[fresh-compact] bridge ${agent.id}/${target.sessionKey} skipped: ${err?.message || err}`);
          }
          await sleep(this._delayBetweenJobsMs);
        }
      }
      for (const agent of this._listAgents()) {
        const projectionFiles = listAgentPhoneProjectionFiles(agent.agentDir);
        for (const projectionFile of projectionFiles) {
          try {
            const projection = readAgentPhoneProjection(projectionFile);
            const meta = projection.meta || {};
            const conversationId = meta.conversationId;
            if (!conversationId) continue;
            const decision = shouldRunFreshCompact({ meta, now });
            if (!decision.run) continue;

            await freshCompactAgentPhoneSession(agent.id, {
              engine: this._engine,
              conversationId,
              conversationType: meta.conversationType || "channel",
              now,
              reason: decision.reason || "daily",
            });
            result.phoneCompacted += 1;
          } catch (err) {
            result.failed += 1;
            result.staleRemaining += 1;
            console.warn(`[fresh-compact] phone ${agent.id}/${projectionFile} skipped: ${err?.message || err}`);
          }
          await sleep(this._delayBetweenJobsMs);
        }
      }
      return result;
    } finally {
      this._running = false;
    }
  }
}
