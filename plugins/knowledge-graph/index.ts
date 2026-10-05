// @ts-nocheck
import { GraphStore } from "./lib/graph-store.ts";
import { GraphTaskManager } from "./lib/graph-task-manager.ts";

export default class KnowledgeGraphPlugin {
  async onload() {
    const store = new GraphStore(this.ctx.dataDir);
    const taskManager = new GraphTaskManager(store, {
      bus: this.ctx.bus,
      dataDir: this.ctx.dataDir,
      log: this.ctx.log,
    });
    this.ctx._knowledgeGraph = { store, taskManager };

    this.register(() => {
      taskManager.destroy();
      store.destroy();
      delete this.ctx._knowledgeGraph;
    });

    this.ctx.log.info("knowledge graph plugin loaded");
  }
}
