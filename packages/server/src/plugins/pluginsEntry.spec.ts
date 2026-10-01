import * as pluginCore from "@hot-updater/plugin-core";
import * as pluginCoreInternal from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import * as plugins from "./index";

// Plugin authors import the authoring API from @hot-updater/plugin-core. This
// entry exports the same functions and classes until it is removed, so a
// plugin written against either runs on the same server.
/** Exported here but kept off plugin-core's root: Hot Updater's own routes use it. */
const INTERNAL = new Set(["isDatabaseBusyError"]);

describe("@hot-updater/server/plugins", () => {
  it("exports what @hot-updater/plugin-core does, as the same values", () => {
    const names = Object.keys(plugins);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const source: Record<string, unknown> = INTERNAL.has(name)
        ? pluginCoreInternal
        : pluginCore;
      expect(source, name).toHaveProperty(name);
      expect(source[name], name).toBe(
        (plugins as Record<string, unknown>)[name],
      );
    }
  });
});
