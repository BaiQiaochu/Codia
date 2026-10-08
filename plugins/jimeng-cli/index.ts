/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  jimengImageAdapter,
  jimengVideoAdapter,
} from "./adapters/dreamina.ts";

export default class JimengCliPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("jimeng-cli plugin loaded without event bus");
      return;
    }

    for (const adapter of [jimengImageAdapter, jimengVideoAdapter]) {
      const result = await bus.request("media-gen:register-adapter", { adapter });
      if (result?.ok === false) {
        throw new Error(result.error || `failed to register ${adapter.id}`);
      }
      log?.info?.(`jimeng-cli adapter registered: ${adapter.id}`);
      this.register?.(() => {
        bus.request("media-gen:unregister-adapter", { adapterId: adapter.id }).catch(() => {});
      });
    }
  }
}
