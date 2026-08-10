import { describe, expect, it } from "vitest";

import { createManagedServerPlugins } from "./index";

describe("createManagedServerPlugins", () => {
  it("creates the ordered managed runtime preset with the Analytics schema", () => {
    const plugins = createManagedServerPlugins();

    expect(
      plugins.map((plugin) => Reflect.get(plugin, "id") as unknown),
    ).toEqual([
      "better-auth-managed-access-key",
      "managed-auth-route-policy",
      "analytics",
    ]);
    expect(
      plugins.map((plugin) => {
        const schema = Reflect.get(plugin, "schema") as unknown;
        return typeof schema === "object" && schema !== null
          ? (Reflect.get(schema, "id") as unknown)
          : null;
      }),
    ).toEqual([null, null, "analytics"]);
    expect(Object.isFrozen(plugins)).toBe(true);
  });
});
