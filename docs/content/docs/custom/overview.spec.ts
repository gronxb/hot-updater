import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("custom server telemetry guide", () => {
  it("documents explicit telemetry opt-in and deployment-owned policy", () => {
    const guide = readFileSync(
      new URL("./overview.mdx", import.meta.url),
      "utf8",
    );
    const normalizedGuide = guide.replace(/\s+/g, " ");

    expect(guide).toContain(
      "The `/bundle-events/app-ready` endpoint is not mounted by default.",
    );
    expect(guide).toContain("bundleEvents: {");
    expect(guide).toContain("policy: (request, context) => {");
    expect(guide).toContain("context.env?.HOT_UPDATER_EVENT_TOKEN");
    expect(guide).toContain("if (token && authorization ===");
    expect(guide).toContain("retention: { maxAgeMs:");
    expect(normalizedGuide).toContain(
      "an in-memory counter does not coordinate",
    );
    expect(normalizedGuide).toContain(
      "Workers can use KV, Durable Objects, rate-limit bindings",
    );
  });
});
