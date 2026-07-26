import { describe, expect, it, vi } from "vitest";

describe("capability process authority", () => {
  it("publishes only a frozen versioned authority surface", async () => {
    // Given
    await import("./capabilities");
    const key = Symbol.for("@hot-updater/plugin-core/capability-authority/v1");

    // When
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    const authority = descriptor?.value;

    // Then
    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(
      Reflect.ownKeys(authority).sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    ).toEqual(["attach", "define", "defineShared", "get", "version"]);
    expect(Reflect.get(authority, "version")).toBe(1);
  });

  it("shares internal tokens and carrier snapshots across module instances", async () => {
    // Given
    vi.resetModules();
    const first = await import("./capabilities");
    const token = first.defineSharedCapability({
      id: "shared-module-authority@1",
      parse: String,
    });

    // When
    vi.resetModules();
    const second = await import("./capabilities");
    const sharedToken = second.defineSharedCapability({
      id: "shared-module-authority@1",
      parse: Number,
    });
    const carrier = second.attachCapabilityContribution(
      { name: "database" },
      { create: () => "ready", token: sharedToken },
    );

    // Then
    expect(sharedToken).toBe(token);
    expect(sharedToken.parse("7")).toBe("7");
    expect(first.getCapabilityContributions(carrier)).toEqual([
      expect.objectContaining({ token }),
    ]);
  });

  it("accepts an authentic ordinary token across module instances", async () => {
    // Given
    vi.resetModules();
    const first = await import("./capabilities");
    const token = first.defineCapability({
      id: "authentic-module-authority@1",
      parse: String,
    });

    // When
    vi.resetModules();
    const second = await import("./capabilities");
    const carrier = second.attachCapabilityContribution(
      { name: "database" },
      { create: () => "ready", token },
    );

    // Then
    expect(second.getCapabilityContributions(carrier)).toEqual([
      expect.objectContaining({ token }),
    ]);
  });

  it("keeps ordinary tokens fresh across module instances", async () => {
    // Given
    vi.resetModules();
    const first = await import("./capabilities");
    const firstToken = first.defineCapability({
      id: "fresh-module-authority@1",
      parse: String,
    });

    // When
    vi.resetModules();
    const second = await import("./capabilities");
    const secondToken = second.defineCapability({
      id: "fresh-module-authority@1",
      parse: String,
    });

    // Then
    expect(secondToken).not.toBe(firstToken);
  });
});
