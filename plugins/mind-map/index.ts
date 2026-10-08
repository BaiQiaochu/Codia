// @ts-nocheck
import { MindMapStore } from "./lib/mind-map-store.ts";

export default class MindMapPlugin {
  async onload() {
    const store = new MindMapStore(this.ctx.dataDir);
    this.ctx._mindMap = { store };

    this.register(() => {
      delete this.ctx._mindMap;
    });

    this.ctx.log.info("mind map plugin loaded");
  }
}
