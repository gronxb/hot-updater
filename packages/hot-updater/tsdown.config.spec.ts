import { describe, expect, it } from "vitest";

import { INIT_PROVIDER_PACKAGES } from "./src/commands/initProviders";
import config from "./tsdown.config";

describe("the CLI build", () => {
  it("inlines every provider's init entry, so init reads each provider's server definitions whichever provider packages a project installed", () => {
    const alwaysBundle =
      (
        config as {
          readonly deps?: {
            readonly alwaysBundle?: readonly (string | RegExp)[];
          };
        }
      ).deps?.alwaysBundle ?? [];

    for (const { packageName } of Object.values(INIT_PROVIDER_PACKAGES)) {
      const entry = `${packageName}/init`;
      expect(
        alwaysBundle.some((pattern) =>
          typeof pattern === "string" ? pattern === entry : pattern.test(entry),
        ),
        entry,
      ).toBe(true);
    }
  });
});
