import { isLess, normalize } from "verkit";
import { describe, expect, it } from "vitest";

import { UPDATE_TARGETS } from "./doctorInfrastructureTargets";
import { INFRASTRUCTURE_UPDATES } from "./infrastructureUpdates";
import { INIT_PROVIDER_NAMES } from "./initProviders";

describe("infrastructure upgrade requirements", () => {
  it("makes every doctor requirement carry ordered, complete upgrade instructions", () => {
    expect(UPDATE_TARGETS).toBe(INFRASTRUCTURE_UPDATES);
    let previousVersion: string | undefined;
    for (const entry of INFRASTRUCTURE_UPDATES) {
      expect(normalize(entry.version)).toBe(entry.version);
      if (previousVersion)
        expect(isLess(previousVersion, entry.version)).toBe(true);
      previousVersion = entry.version;
      expect(Object.keys(entry.providers).sort()).toEqual(
        [...INIT_PROVIDER_NAMES].sort(),
      );
      for (const steps of [
        entry.steps,
        entry.verification,
        ...Object.values(entry.providers),
      ]) {
        expect(steps.length).toBeGreaterThan(0);
        for (const step of steps) {
          expect(step.trim().length).toBeGreaterThan(0);
          expect(step).not.toMatch(/\b(TODO|TBD|FIXME)\b/);
        }
      }
      expect(entry.compatibility.trim()).not.toBe("");
      expect(entry.note.trim()).not.toBe("");
    }
  });

  it("starts with the supported v0-to-v1 cutover and provider reuse boundaries", () => {
    const first = INFRASTRUCTURE_UPDATES[0];
    expect(first.version).toBe("1.0.0");
    expect(first.compatibility).toContain("cannot be upgraded in place");
    expect(first.steps.join("\n")).toContain("not backfilled");
    expect(first.steps.join("\n")).toContain(
      "Do not deliver v1 React Native SDK JavaScript to a v0 native binary",
    );
    expect(first.providers.supabase.join("\n")).toContain(
      "project can be reused",
    );
    expect(first.providers.firebase.join("\n")).toContain(
      "project can be reused",
    );
    expect(first.providers.cloudflare.join("\n")).toContain("separate D1");
    expect(first.providers.aws.join("\n")).toContain("separate DynamoDB");
  });
});
