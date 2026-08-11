import { describe, expect, it, vi } from "vitest";

const managedPluginMocks = vi.hoisted(() => ({
  managedBetterAuthPlugin: vi.fn(),
}));

vi.mock("@hot-updater/better-auth/managed", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/better-auth/managed")>();
  managedPluginMocks.managedBetterAuthPlugin.mockImplementation(
    actual.managedBetterAuthPlugin,
  );
  return {
    ...actual,
    managedBetterAuthPlugin: managedPluginMocks.managedBetterAuthPlugin,
  };
});

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
    ).toEqual(["better-auth-managed-access-keys", null, "analytics"]);
    expect(Object.isFrozen(plugins)).toBe(true);
  });

  it("forwards an external management bearer only to authentication", () => {
    createManagedServerPlugins({ managementBearerToken: "management-secret" });

    expect(managedPluginMocks.managedBetterAuthPlugin).toHaveBeenLastCalledWith(
      {
        managementBearerToken: "management-secret",
      },
    );
  });
});
