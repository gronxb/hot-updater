import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { transformFileSync } from "@babel/core";
import { describe, expect, it, vi } from "vitest";

import { importPublished } from "./published.ts";

const { INVALID_COHORT_ERROR_MESSAGE, isValidCohort, normalizeCohortValue } =
  await importPublished<typeof import("@hot-updater/protocol")>(
    "@hot-updater/protocol",
  );

function fixture() {
  let nativeCohort = "123";
  const screenState: Record<string, string> = {};
  const setCohort = vi.fn((input: string) => {
    const normalized = normalizeCohortValue(input);
    if (!isValidCohort(normalized))
      throw new Error(INVALID_COHORT_ERROR_MESSAGE);
    nativeCohort = normalized;
  });
  const persistScreenState = vi.fn(async (patch: Record<string, string>) => {
    Object.assign(screenState, patch);
  });
  const readPersistedScreenState = vi.fn(async () => screenState);
  const code = transformFileSync(
    fileURLToPath(
      new URL(
        "../../examples/v0.85.0/src/e2eApp/useE2eRuntime.ts",
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
    Error,
    exports,
    require: (name: string) => {
      if (name === "@hot-updater/react-native")
        return {
          HotUpdater: { getCohort: () => nativeCohort, setCohort },
          useHotUpdaterStore: () => ({}),
        };
      if (name === "react")
        return {
          useCallback: (callback: unknown) => callback,
          useEffect: () => undefined,
          useRef: (value: unknown) => ({ current: value }),
          useState: (value: unknown) => [
            typeof value === "function" ? value() : value,
            vi.fn(),
          ],
        };
      if (name === "react-native" || name === "react-native-bootsplash")
        return {};
      if (name === "valtio") return { useSnapshot: () => ({}) };
      if (name === "./runtime")
        return {
          readRuntimeSnapshot: () => ({}),
          refreshRuntimeSnapshot: async () => ({}),
          formatUpdateStoreDownloadPaths: () => "",
        };
      if (name === "./screen-state-persistence")
        return { persistScreenState, readPersistedScreenState };
      if (name === "./startup-check") return {};
      if (name === "./useCapturedUpdateActions")
        return { useCapturedUpdateActions: () => ({}) };
      if (name === "./useRemoteConfigActions")
        return { useRemoteConfigActions: () => ({}) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const useModel = exports.useE2eRuntimeModel as () => {
    updateCohortInput: (input: string) => void;
    applyCohortInput: () => Promise<void>;
  };
  return {
    model: useModel(),
    setCohort,
    screenState,
    getNativeCohort: () => nativeCohort,
  };
}

describe("cohort input draft and explicit apply", () => {
  it.each(["456", "qa"])(
    "accepts Android fill's clear and partial drafts before applying %s",
    async (cohort) => {
      const f = fixture();
      for (const draft of ["", cohort.slice(0, 1), cohort]) {
        expect(() => f.model.updateCohortInput(draft)).not.toThrow();
        expect(f.screenState.cohortInput).toBe(draft);
        expect(f.setCohort).not.toHaveBeenCalled();
        expect(f.getNativeCohort()).toBe("123");
      }
      await f.model.applyCohortInput();
      expect(f.setCohort).toHaveBeenCalledExactlyOnceWith(cohort);
      expect(f.getNativeCohort()).toBe(cohort);
      expect(f.screenState.cohortActionResult).toBe(`set -> ${cohort}`);
    },
  );

  it.each(["", "qa user"])(
    "reports an invalid explicit apply of %j without changing the active cohort",
    async (draft) => {
      const f = fixture();
      f.model.updateCohortInput(draft);
      await expect(f.model.applyCohortInput()).resolves.toBeUndefined();
      expect(f.setCohort).toHaveBeenCalledExactlyOnceWith(draft);
      expect(f.getNativeCohort()).toBe("123");
      expect(f.screenState.cohortActionResult).toBe(
        `set -> error ${INVALID_COHORT_ERROR_MESSAGE}`,
      );
    },
  );
});
