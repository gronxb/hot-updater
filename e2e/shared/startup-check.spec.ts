import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { transformFileSync } from "@babel/core";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const checkForUpdate = vi.fn<() => Promise<unknown>>(async () => null);
  const reload = vi.fn(async () => undefined);
  const persistScreenState = vi.fn(async (_patch: unknown) => undefined);
  const readE2eRuntimeConfig = vi.fn(async () => ({
    screenState: { startupCheckEpoch: "launch-1" },
  }));
  const logError = vi.fn();
  const code = transformFileSync(
    fileURLToPath(
      new URL(
        "../../examples/v0.85.0/src/e2eApp/startup-check.ts",
        import.meta.url,
      ),
    ),
    {
      babelrc: false,
      configFile: false,
      presets: ["@babel/preset-typescript"],
      plugins: ["@babel/plugin-transform-modules-commonjs"],
    },
  )!.code!;
  const exports: Record<string, unknown> = {};
  new Script(code).runInNewContext({
    exports,
    console: { error: logError },
    require: (name: string) => {
      if (name === "@hot-updater/react-native")
        return { HotUpdater: { checkForUpdate, reload } };
      if (name === "../e2eRuntimeConfig") return { readE2eRuntimeConfig };
      if (name === "./screen-state-persistence") return { persistScreenState };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    checkForUpdate,
    reload,
    persistScreenState,
    readE2eRuntimeConfig,
    logError,
    run: exports.runStartupUpdateCheck as (
      isActive: () => boolean,
    ) => Promise<void>,
  };
}

describe("app startup catalog check acknowledgement", () => {
  it("acknowledges only after the captured launch's catalog check settles", async () => {
    const f = fixture();
    const called = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    f.checkForUpdate.mockImplementationOnce(() => {
      called.resolve();
      return response.promise;
    });
    const run = f.run(() => true);
    await called.promise;
    expect(f.persistScreenState).not.toHaveBeenCalled();
    f.readE2eRuntimeConfig.mockResolvedValue({
      screenState: { startupCheckEpoch: "next-launch" },
    });
    response.resolve(null);
    await run;
    expect(f.persistScreenState).toHaveBeenCalledWith({
      startupCheckSettledEpoch: "launch-1",
    });
    expect(f.readE2eRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a rejected catalog check as settled and preserves error logging", async () => {
    const f = fixture();
    const error = new Error("catalog failed");
    f.checkForUpdate.mockRejectedValueOnce(error);
    await f.run(() => true);
    expect(f.logError).toHaveBeenCalledWith(error);
    expect(f.persistScreenState).toHaveBeenCalledWith({
      startupCheckSettledEpoch: "launch-1",
    });
  });

  it("leaves forced-reload completion for the replacement runtime", async () => {
    const f = fixture();
    const updateBundle = vi.fn(async () => true);
    f.checkForUpdate.mockResolvedValueOnce({
      shouldForceUpdate: true,
      updateBundle,
    });
    await f.run(() => true);
    expect(updateBundle).toHaveBeenCalledOnce();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.persistScreenState).not.toHaveBeenCalled();
    await f.run(() => true);
    expect(f.persistScreenState).toHaveBeenCalledWith({
      startupCheckSettledEpoch: "launch-1",
    });
  });

  it("does not publish an acknowledgement after unmount during the catalog check", async () => {
    const f = fixture();
    let active = true;
    f.checkForUpdate.mockImplementationOnce(async () => {
      active = false;
      return null;
    });
    await f.run(() => active);
    expect(f.persistScreenState).not.toHaveBeenCalled();
  });

  it("still checks the update provider when the optional E2E controller is unavailable", async () => {
    const f = fixture();
    f.readE2eRuntimeConfig.mockRejectedValueOnce(
      new Error("controller offline"),
    );
    await f.run(() => true);
    expect(f.checkForUpdate).toHaveBeenCalledWith({
      updateStrategy: "appVersion",
    });
    expect(f.persistScreenState).not.toHaveBeenCalled();
  });

  it("does not start a catalog check when unmounted while reading the epoch", async () => {
    const f = fixture();
    const captured = Promise.withResolvers<{
      screenState: { startupCheckEpoch: string };
    }>();
    f.readE2eRuntimeConfig.mockReturnValueOnce(captured.promise);
    let active = true;
    const run = f.run(() => active);
    active = false;
    captured.resolve({ screenState: { startupCheckEpoch: "launch-1" } });
    await run;
    expect(f.checkForUpdate).not.toHaveBeenCalled();
    expect(f.persistScreenState).not.toHaveBeenCalled();
  });
});
