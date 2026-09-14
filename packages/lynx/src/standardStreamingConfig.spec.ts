import { describe, expect, it, vi } from "vitest";

vi.mock("@octanejs/rspeedy-plugin", () => ({
  pluginOctane: () => ({ name: "octane:test" }),
}));

interface ConfigPlugin {
  readonly name?: string;
  readonly setup?: (api: unknown) => Promise<void> | void;
}

interface LynxExampleConfig {
  readonly plugins?: readonly (ConfigPlugin | readonly ConfigPlugin[])[];
  readonly source?: {
    readonly entry?: Record<string, string>;
  };
}

const configs = [
  ["ReactLynx", () => import("../../../examples/lynx/react/lynx.config")],
  ["VueLynx", () => import("../../../examples/lynx/vue/lynx.config")],
  [
    "OctaneLynx",
    // @ts-expect-error The pinned Octane config is JavaScript without declarations.
    () => import("../../../examples/lynx/octane/lynx.config.mjs"),
  ],
  ["native E2E", () => import("../../../examples/lynx/e2e.lynx.config")],
] as const;

describe("Lynx example standard streaming configuration", () => {
  it.each(configs)(
    "enables standard Fetch streaming for the %s main and detail pages",
    async (_name, loadConfig) => {
      const config = (await loadConfig()).default as LynxExampleConfig;
      expect(Object.keys(config.source?.entry ?? {}).sort()).toEqual([
        "detail",
        "main",
      ]);

      const plugins = (config.plugins ?? []).flat() as ConfigPlugin[];
      const plugin = plugins.find(({ name }) => name === "lynx:config");
      expect(plugin?.setup).toBeTypeOf("function");

      const exposed = new Map<symbol, unknown>();
      let modifyBundlerChain: ((chain: unknown) => void) | undefined;
      await plugin!.setup!({
        expose: (key: symbol, value: unknown) => exposed.set(key, value),
        isPluginExists: vi.fn(() => false),
        modifyBundlerChain: (modify: (chain: unknown) => void) => {
          modifyBundlerChain = modify;
        },
        useExposed: (key: symbol) =>
          key === Symbol.for("LynxTemplatePlugin")
            ? { LynxTemplatePlugin: class {} }
            : undefined,
      });
      expect(exposed.get(Symbol.for("lynx.config"))).toEqual({
        config: { enableFetchAPIStandardStreaming: true },
      });

      let bundlerOptions: unknown;
      modifyBundlerChain!({
        plugin: (name: string) => {
          expect(name).toBe("lynx:config");
          return {
            use: (_pluginClass: unknown, options: readonly unknown[]) => {
              bundlerOptions = options[0];
            },
          };
        },
      });
      expect(bundlerOptions).toMatchObject({
        config: { enableFetchAPIStandardStreaming: true },
      });
    },
  );
});
