import type { Compiler, RspackPluginInstance } from "@rspack/core";

export class HotUpdaterPlugin implements RspackPluginInstance {
  apply(_compiler: Compiler) {
    // Bundle IDs are now issued at deploy/build-plugin time and stored in manifest.json.
  }
}
