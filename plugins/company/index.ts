// @ts-nocheck
import { createCompanyService } from "./lib/company-service.ts";

export default class CompanyPlugin {
  async onload() {
    const service = createCompanyService(this.ctx);
    this.ctx._company = { service };

    const bus = this.ctx.bus;
    if (bus?.handle) {
      this.register(bus.handle("company:create-default", (input = {}) => service.createDefaultCompany(input)));
      this.register(bus.handle("company:bind-channel", (input = {}) => service.bindChannel(input)));
      this.register(bus.handle("company:ingest-channel-message", (input = {}) =>
        service.ingestChannelMessage(input.channelId, input)));
      this.register(bus.handle("company:post-channel-reply", (input = {}) =>
        service.postChannelReply(input.channelId, input)));
      this.register(bus.handle("company:assign-command", (input = {}) => service.assignCommand(input)));
      this.register(bus.handle("company:assign-from-canvas", (input = {}) => service.assignFromCanvas(input)));
      this.register(bus.handle("company:status", (input = {}) => service.getStatus(input.companyId)));
    }

    this.register(() => {
      delete this.ctx._company;
    });

    this.ctx.log.info("company plugin loaded");
  }
}
