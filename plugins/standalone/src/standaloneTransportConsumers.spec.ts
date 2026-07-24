import { analyticsProviderToken } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "./standaloneRepository";
import { standaloneStorage } from "./standaloneStorage";

class MissingAnalyticsCapabilityError extends Error {}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standalone credentialed transport consumers", () => {
  it("guards repository database requests", async () => {
    // Given
    let observedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        observedRequest = new Request(input, init);
        return Response.json({ data: { channels: [] } });
      }),
    );
    const repository = standaloneRepository({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { Authorization: "Bearer database" },
    });

    // When
    await repository.getChannels?.();

    // Then
    expect(observedRequest?.redirect).toBe("error");
    expect(observedRequest?.headers.get("Authorization")).toBe(
      "Bearer database",
    );
  });

  it("guards Analytics forwarding and owns the SDK header", async () => {
    // Given
    let observedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        observedRequest = new Request(input, init);
        return Response.json({});
      }),
    );
    const repository = standaloneRepository({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { "Hot-Updater-SDK-Version": "common-secret" },
      routes: {
        appendEvent: () => ({
          path: "/events",
          headers: { "Hot-Updater-SDK-Version": "route-secret" },
        }),
      },
    });
    const [contribution] = getCapabilityContributions(repository);
    if (contribution === undefined) throw new MissingAnalyticsCapabilityError();
    const provider = analyticsProviderToken.parse(
      contribution.create({ database: repository, storages: [] }),
    );

    // When
    await provider.appendBundleEvent({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: null,
      installId: "install-1",
      platform: "ios",
      sdkVersion: "1.2.3",
      toBundleId: "bundle-1",
      type: "UNCHANGED",
      updateStrategy: null,
    });

    // Then
    expect(observedRequest?.redirect).toBe("error");
    expect(observedRequest?.headers.get("Hot-Updater-SDK-Version")).toBe(
      "1.2.3",
    );
  });

  it("guards storage control requests", async () => {
    // Given
    let observedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        observedRequest = new Request(input, init);
        return new Response("manifest");
      }),
    );
    const storage = standaloneStorage({
      baseUrl: "https://trusted.example/provider",
      commonHeaders: { Authorization: "Bearer storage" },
    })();

    // When
    await storage.profiles.runtime.readText("storage://manifest");

    // Then
    expect(observedRequest?.redirect).toBe("error");
    expect(observedRequest?.headers.get("Authorization")).toBe(
      "Bearer storage",
    );
  });
});
