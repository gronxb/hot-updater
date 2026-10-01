import type {
  InitProviderDefinition,
  RunInitOptions,
} from "@hot-updater/cli-tools";

/** What a provider package's `./init` entry exports. */
export type InitProviderModule = {
  readonly initProvider: InitProviderDefinition;
  readonly runInit: (options: RunInitOptions) => Promise<void>;
};

type InitProviderPackage = {
  readonly devDependencies: readonly string[];
  /** The provider in init's prompt: its package's `initProvider.label`. */
  readonly label: string;
  /**
   * The provider package's `./init`, the provider's whole init. Init imports
   * it once it has installed the package, which the CLI doesn't depend on.
   */
  readonly load: () => Promise<InitProviderModule>;
  readonly packageName: string;
};

export const INIT_PROVIDER_PACKAGES = {
  cloudflare: {
    devDependencies: ["wrangler"],
    label: "Cloudflare D1 + R2 + Worker",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/cloudflare/init"),
    packageName: "@hot-updater/cloudflare",
  },
  aws: {
    devDependencies: [],
    label: "AWS + Lambda@Edge",
    load: (): Promise<InitProviderModule> => import("@hot-updater/aws/init"),
    packageName: "@hot-updater/aws",
  },
  supabase: {
    devDependencies: [],
    label: "Supabase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/supabase/init"),
    packageName: "@hot-updater/supabase",
  },
  firebase: {
    devDependencies: ["firebase-tools", "firebase-admin"],
    label: "Firebase",
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/firebase/init"),
    packageName: "@hot-updater/firebase",
  },
} as const satisfies Record<string, InitProviderPackage>;

export type InitProvider = keyof typeof INIT_PROVIDER_PACKAGES;

export const isInitProvider = (
  value: string | undefined,
): value is InitProvider =>
  value !== undefined && Object.hasOwn(INIT_PROVIDER_PACKAGES, value);

export const INIT_PROVIDER_NAMES = Object.keys(INIT_PROVIDER_PACKAGES).filter(
  isInitProvider,
);

/**
 * The server definitions the other providers' inits write, which
 * `provider`'s init replaces when it finds one unedited. They come from the
 * other provider packages the project has installed, as it does right after
 * switching providers. A provider whose package isn't installed, or whose
 * definitions fail to render, is left out, and init then refuses that
 * definition from its imports instead.
 */
export const otherServerDefinitionsOf = async (
  provider: InitProvider,
): Promise<string[]> =>
  (
    await Promise.all(
      INIT_PROVIDER_NAMES.filter((name) => name !== provider).map(
        async (name) => {
          try {
            const { initProvider } = await INIT_PROVIDER_PACKAGES[name].load();
            return [...(initProvider.serverDefinitions?.() ?? [])];
          } catch {
            return [];
          }
        },
      ),
    )
  ).flat();
