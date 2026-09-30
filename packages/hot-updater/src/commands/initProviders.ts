import { initProvider as awsInitProvider } from "@hot-updater/aws/init";
import type {
  InitProviderDefinition,
  RunInitOptions,
} from "@hot-updater/cli-tools";
import { initProvider as cloudflareInitProvider } from "@hot-updater/cloudflare/init";
import { initProvider as firebaseInitProvider } from "@hot-updater/firebase/init";
import { initProvider as supabaseInitProvider } from "@hot-updater/supabase/init";

type InitProviderModule = {
  readonly runInit: (options: RunInitOptions) => Promise<void>;
};

type InitProviderPackage = {
  readonly definition: InitProviderDefinition;
  readonly devDependencies: readonly string[];
  readonly load: () => Promise<InitProviderModule>;
  readonly packageName: string;
};

export const INIT_PROVIDER_PACKAGES = {
  cloudflare: {
    definition: cloudflareInitProvider,
    devDependencies: ["wrangler"],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/cloudflare/iac"),
    packageName: "@hot-updater/cloudflare",
  },
  aws: {
    definition: awsInitProvider,
    devDependencies: [],
    load: (): Promise<InitProviderModule> => import("@hot-updater/aws/iac"),
    packageName: "@hot-updater/aws",
  },
  supabase: {
    definition: supabaseInitProvider,
    devDependencies: [],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/supabase/iac"),
    packageName: "@hot-updater/supabase",
  },
  firebase: {
    definition: firebaseInitProvider,
    devDependencies: ["firebase-tools", "firebase-admin"],
    load: (): Promise<InitProviderModule> =>
      import("@hot-updater/firebase/iac"),
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
 * `provider`'s init replaces when it finds one unedited. The CLI inlines
 * every provider's init entry, so they are here whichever provider packages
 * the project installed. One that fails to render is left out, and init then
 * refuses that definition from its imports instead.
 */
export const otherServerDefinitionsOf = (provider: InitProvider): string[] =>
  INIT_PROVIDER_NAMES.filter((name) => name !== provider).flatMap((name) => {
    try {
      return [
        ...(INIT_PROVIDER_PACKAGES[name].definition.serverDefinitions?.() ??
          []),
      ];
    } catch {
      return [];
    }
  });
