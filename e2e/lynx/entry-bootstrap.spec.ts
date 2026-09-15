import { afterEach, describe, expect, it, vi } from "vitest";

type Effect = () => unknown;
type Entry = "detail" | "main";

const entryState = vi.hoisted(() => ({ effects: [] as Effect[] }));

const element = (type: unknown, props: unknown) => ({ props, type });

vi.mock("../../examples/lynx/node_modules/@lynx-js/react", () => ({
  root: {
    render(value: { props: unknown; type: unknown }) {
      if (typeof value.type === "function") value.type(value.props);
    },
  },
  useEffect(effect: Effect) {
    entryState.effects.push(effect);
  },
  useRef<T>(value: T) {
    return { current: value };
  },
  useState<T>(value: T) {
    return [value, vi.fn()];
  },
}));
vi.mock("../../examples/lynx/node_modules/@lynx-js/react/jsx-runtime", () => ({
  Fragment: Symbol("Fragment"),
  jsx: element,
  jsxs: element,
}));
vi.mock("../../packages/lynx/dist/index.mjs", () => ({
  HotUpdater: {
    getLaunchConfiguration: vi.fn(async () => ({
      appBaseURL: "http://127.0.0.1:3014/hot-updater",
      launchGeneration: "launch-android",
      runtimeConfigURL: "http://127.0.0.1:3114/e2e/runtime-config",
    })),
    getLaunchInfo: vi.fn(async () => ({
      next: null,
      running: { bundleId: "embedded", releaseId: null },
    })),
    init: vi.fn(),
    notifyAppReady: vi.fn(async () => ({ status: "READY" })),
  },
}));
vi.mock("../../packages/lynx/dist/navigation.mjs", () => ({
  close: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../examples/lynx/src/e2eApp/runtimeObservation", () => ({
  applyForcedUpdate: vi.fn(async () => undefined),
  bootstrapRuntimeReady: vi.fn(
    async (
      configuration: Promise<boolean>,
      _load: unknown,
      _confirm: unknown,
      startPolling: () => void,
    ) => {
      if (!(await configuration)) return false;
      startPolling();
      return true;
    },
  ),
  confirmRuntimeReady: vi.fn(async () => undefined),
  installCheckedUpdate: vi.fn(async () => "installed"),
  readRuntimeSnapshot: vi.fn(async () => ({})),
}));

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "fetch",
);
const originalNativeModulesDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "NativeModules",
);

function restoreGlobal(
  name: "fetch" | "NativeModules",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

async function loadEntry(entry: Entry): Promise<Effect[]> {
  entryState.effects = [];

  if (entry === "main") {
    await import("../../examples/lynx/src/e2eApp/index.tsx");
  } else {
    await import("../../examples/lynx/src/e2eApp/detail.tsx");
  }
  return [...entryState.effects];
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
  restoreGlobal("fetch", originalFetchDescriptor);
  restoreGlobal("NativeModules", originalNativeModulesDescriptor);
});

describe("Lynx E2E page entry bootstrap", () => {
  it.each(["main", "detail"] as const)(
    "evaluates %s without fetch and resolves it when background polling starts",
    async (entry) => {
      vi.useFakeTimers();
      Reflect.deleteProperty(globalThis, "fetch");
      Object.defineProperty(globalThis, "NativeModules", {
        configurable: true,
        value: {},
        writable: true,
      });

      const effects = await loadEntry(entry);
      const fetchState = vi.fn(async (url: string) => {
        const payload = url.includes("/pending-action")
          ? { action: null }
          : url.includes("/runtime-config")
            ? { baseURL: "http://127.0.0.1:3014/hot-updater" }
            : {};
        return {
          json: async () => payload,
          ok: true,
          status: 200,
        };
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: fetchState,
        writable: true,
      });
      effects[0]?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(
        fetchState.mock.calls.some(([url]) => url.includes("/pending-action")),
      ).toBe(true);
      expect(fetchState).toHaveBeenCalledWith(
        "http://127.0.0.1:3114/e2e/pending-action",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      if (entry === "detail") {
        expect(fetchState).toHaveBeenCalledWith(
          "http://127.0.0.1:3114/e2e/screen-state",
          expect.objectContaining({
            body: expect.stringContaining(
              '"launchGeneration":"launch-android"',
            ),
            method: "POST",
          }),
        );
      }
    },
  );
});
