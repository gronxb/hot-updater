import { describe, expect, it } from "vitest";

import { createDatabaseAnalyticsRuntime } from "./databaseAnalyticsRuntime";
import type {
  DatabaseAnalyticsOperations,
  HotUpdaterContext,
  TelemetryKeyCredential,
} from "./types";

type TestTelemetryKeyCredential = TelemetryKeyCredential & {
  readonly active: boolean;
};

type TestAnalyticsOperations = DatabaseAnalyticsOperations & {
  readonly setTelemetryKeyActive: (
    active: boolean,
    context?: HotUpdaterContext,
  ) => Promise<void>;
};

type TestAnalyticsRuntime = ReturnType<
  typeof createDatabaseAnalyticsRuntime
> & {
  readonly setTelemetryKeyActive?: (
    active: boolean,
    context?: HotUpdaterContext,
  ) => Promise<void>;
};

describe("database analytics runtime telemetry keys", () => {
  it("issues enabled keys, can disable and re-enable them, and rejects stale rotated keys", async () => {
    let credential: TestTelemetryKeyCredential | null = null;
    const operations = {
      async getTelemetryKeyCredential() {
        return credential;
      },
      async setTelemetryKeyActive(active) {
        if (!credential) {
          throw new Error("No telemetry key has been issued.");
        }
        credential = { ...credential, active };
      },
      async upsertTelemetryKeyCredential(nextCredential) {
        credential = { ...nextCredential, active: true };
      },
    } satisfies TestAnalyticsOperations;
    const runtime = createDatabaseAnalyticsRuntime(
      operations,
    ) as TestAnalyticsRuntime;

    const issued = await runtime.issueTelemetryKey?.();

    expect(issued).toBeDefined();
    expect(await runtime.getTelemetryKeyState?.()).toEqual({
      active: true,
      telemetryKeySuffix: issued?.telemetryKeySuffix,
    });
    expect(await runtime.authenticateTelemetryKey?.(issued!.telemetryKey)).toBe(
      true,
    );

    await runtime.setTelemetryKeyActive?.(false);

    expect(await runtime.getTelemetryKeyState?.()).toEqual({
      active: false,
      telemetryKeySuffix: issued?.telemetryKeySuffix,
    });
    expect(await runtime.authenticateTelemetryKey?.(issued!.telemetryKey)).toBe(
      false,
    );

    await runtime.setTelemetryKeyActive?.(true);
    expect(await runtime.authenticateTelemetryKey?.(issued!.telemetryKey)).toBe(
      true,
    );

    const rotated = await runtime.rotateTelemetryKey?.();

    expect(rotated?.telemetryKey).not.toBe(issued?.telemetryKey);
    expect(await runtime.getTelemetryKeyState?.()).toEqual({
      active: true,
      telemetryKeySuffix: rotated?.telemetryKeySuffix,
    });
    expect(await runtime.authenticateTelemetryKey?.(issued!.telemetryKey)).toBe(
      false,
    );
    expect(
      await runtime.authenticateTelemetryKey?.(rotated!.telemetryKey),
    ).toBe(true);
  });
});
