import { DefaultResourceLoader as PiResourceLoader } from "@earendil-works/pi-coding-agent";

type LoaderOptions = ConstructorParameters<typeof PiResourceLoader>[0];

/** Keep the application's mutable extension factory list live across SDK reloads. */
export class DefaultResourceLoader extends PiResourceLoader {
  private readonly liveExtensionFactories: LoaderOptions["extensionFactories"];

  constructor(options: LoaderOptions) {
    super(options);
    this.liveExtensionFactories = options.extensionFactories;
  }

  override async reload(options?: Parameters<PiResourceLoader["reload"]>[0]): Promise<void> {
    if (this.liveExtensionFactories) {
      // Pi 1.1.0 copies this list in its constructor and has no public setter.
      // Keep this internal dependency at the SDK boundary, covered by a real-SDK
      // contract test. Built-ins retain the SDK's separate discovery/trust path.
      const sdkFactories = Reflect.get(this, "extensionFactories");
      if (!Array.isArray(sdkFactories)) {
        throw new Error("Unsupported Pi resource loader: extension factory storage changed");
      }
      const inlineFactories = this.liveExtensionFactories.filter(
        (factory) => typeof factory === "function" || factory.builtin !== true,
      );
      sdkFactories.splice(0, sdkFactories.length, ...inlineFactories);
    }
    await super.reload(options);
  }
}
