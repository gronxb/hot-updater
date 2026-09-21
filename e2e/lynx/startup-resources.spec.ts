import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  bootstrapRuntimeReady,
  confirmRuntimeReady,
} from "../../examples/lynx/src/e2eApp/runtimeObservation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("Lynx E2E startup resources", () => {
  it("renders a visible managed CSS background in matrix screenshots", () => {
    const appSource = fs.readFileSync(
      path.join(repo, "examples/lynx/src/e2eApp/index.tsx"),
      "utf8",
    );
    const matrixSource = fs.readFileSync(
      path.join(repo, "e2e/lynx/scripts/run-public-matrix.ts"),
      "utf8",
    );

    expect(appSource).toContain(
      'backgroundImage: `url("${E2E_STARTUP_IMAGE_URL}")`',
    );
    expect(matrixSource).toContain(
      "assertNoManagedResourceEngineErrors(allLogs)",
    );
    expect(matrixSource).toContain(
      "adapter.screenshot(`${cellId}-embedded-A`)",
    );
  });

  it("registers the managed iOS provider for external scripts and fonts", () => {
    const source = fs.readFileSync(
      path.join(
        repo,
        "packages/lynx/ios/Sources/HotUpdaterLynxSparkling/HotUpdaterSparklingHost.swift",
      ),
      "utf8",
    );
    const registrations = [
      ...source.matchAll(
        /addLynxResourceProvider\(\s*(LYNX_PROVIDER_TYPE_[A-Z_]+)/g,
      ),
    ].map((match) => match[1]);

    expect(registrations).toEqual([
      "LYNX_PROVIDER_TYPE_EXTERNAL_JS",
      "LYNX_PROVIDER_TYPE_FONT",
    ]);
  });

  it("waits for the rendered image and loads every sdk3 startup resource", async () => {
    vi.resetModules();
    const { loadE2EStartupResources, markE2EStartupImageLoaded } =
      await import("../../examples/lynx/src/e2eApp/patchSurface");
    const loadFont = vi.fn(async () => undefined);
    const loadExternal = vi.fn(async () => ({ lazyVariant: "A" }));
    const loadDynamic = vi.fn(async () => "A");
    let settled = false;
    const loading = loadE2EStartupResources({
      loadFont,
      loadExternal,
      loadDynamic,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(loadFont).not.toHaveBeenCalled();

    markE2EStartupImageLoaded();
    await loading;

    expect(loadFont).toHaveBeenCalledWith("hot-updater:///assets/probe.ttf");
    expect(loadExternal).toHaveBeenCalledWith(
      "hot-updater:///assets/bootstrap.js",
    );
    expect(loadDynamic).toHaveBeenCalledWith(
      "hot-updater:///dynamic/component.lynx.bundle",
    );
  });

  it("withholds native readiness and marker publication until configuration and every resource settle", async () => {
    vi.resetModules();
    const { loadE2EStartupResources, markE2EStartupImageLoaded } =
      await import("../../examples/lynx/src/e2eApp/patchSurface");
    const configuration = deferred<boolean>();
    const font = deferred<void>();
    const external = deferred<{ lazyVariant: string }>();
    const dynamic = deferred<string>();
    const notifyAppReady = vi.fn(async () => ({ status: "READY" as const }));
    const publishMarker = vi.fn(async () => undefined);
    const startControlPolling = vi.fn();
    const bootstrap = bootstrapRuntimeReady(
      configuration.promise,
      () =>
        loadE2EStartupResources({
          loadFont: () => font.promise,
          loadExternal: () => external.promise,
          loadDynamic: () => dynamic.promise,
        }),
      () => confirmRuntimeReady({ notifyAppReady }, publishMarker),
      startControlPolling,
    );

    markE2EStartupImageLoaded();
    await Promise.resolve();
    expect(notifyAppReady).not.toHaveBeenCalled();

    configuration.resolve(true);
    await Promise.resolve();
    expect(notifyAppReady).not.toHaveBeenCalled();

    font.resolve();
    await Promise.resolve();
    external.resolve({ lazyVariant: "A" });
    await Promise.resolve();
    expect(notifyAppReady).not.toHaveBeenCalled();

    dynamic.resolve("A");
    await expect(bootstrap).resolves.toBe(true);
    expect(notifyAppReady).toHaveBeenCalledOnce();
    expect(publishMarker).toHaveBeenCalledOnce();
    expect(startControlPolling).toHaveBeenCalledOnce();
    expect(publishMarker.mock.invocationCallOrder[0]).toBeLessThan(
      startControlPolling.mock.invocationCallOrder[0],
    );
  });

  it("does not start pending-action polling when marker publication fails", async () => {
    const startControlPolling = vi.fn();

    await expect(
      bootstrapRuntimeReady(
        Promise.resolve(true),
        async () => undefined,
        async () => {
          throw new Error("marker was not acknowledged");
        },
        startControlPolling,
      ),
    ).rejects.toThrow("marker was not acknowledged");
    expect(startControlPolling).not.toHaveBeenCalled();
  });

  it("never confirms or publishes when startup resources are mixed", async () => {
    vi.resetModules();
    const { loadE2EStartupResources, markE2EStartupImageLoaded } =
      await import("../../examples/lynx/src/e2eApp/patchSurface");
    const notifyAppReady = vi.fn(async () => ({ status: "READY" as const }));
    const publishMarker = vi.fn(async () => undefined);
    markE2EStartupImageLoaded();

    await expect(
      bootstrapRuntimeReady(
        Promise.resolve(true),
        () =>
          loadE2EStartupResources({
            loadFont: async () => undefined,
            loadExternal: async () => ({ lazyVariant: "A" }),
            loadDynamic: async () => "B",
          }),
        () => confirmRuntimeReady({ notifyAppReady }, publishMarker),
      ),
    ).rejects.toThrow("Missing or mixed Lynx E2E startup resources");
    expect(notifyAppReady).not.toHaveBeenCalled();
    expect(publishMarker).not.toHaveBeenCalled();
  });
});
