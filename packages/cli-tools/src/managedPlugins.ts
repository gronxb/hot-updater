import {
  formatManagedPlugins,
  MANAGED_PLUGIN_IDS,
  type ManagedPluginId,
  parseManagedPlugins,
} from "@hot-updater/server/plugins";

import type { ProviderConfig } from "./ConfigBuilder";
import { InitError } from "./initOptions";
import type { InitProviderInputDefinition } from "./initProvider";
import { p } from "./prompts";

/**
 * The init input every managed provider shares: the plugins its prebuilt
 * server runs, as `parseManagedPlugins` reads them. Init saves it to
 * `.env.hotupdater`, so running init again keeps the selection.
 */
export const managedPluginsInput = {
  envKey: "HOT_UPDATER_PLUGINS",
  help: `Server plugins to run: ${MANAGED_PLUGIN_IDS.join(", ")} separated by commas, or "none" (default: all)`,
  optional: true,
} as const satisfies InitProviderInputDefinition;

const LABELS: Readonly<
  Record<ManagedPluginId, { readonly label: string; readonly hint: string }>
> = {
  insights: {
    label: "Insights",
    hint: "update events and installation history",
  },
  apiKeys: {
    label: "API keys",
    hint: "client routes require an API key; without it they are public",
  },
  remoteConfig: {
    label: "Remote Config",
    hint: "parameters the app reads at runtime",
  },
};

/** The saved selection, refused with the input's name when it names an unknown plugin. */
const parseSaved = (saved: string | undefined): readonly ManagedPluginId[] => {
  try {
    return parseManagedPlugins(saved);
  } catch (error) {
    throw new InitError(
      `${managedPluginsInput.envKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * The plugins the managed server runs: the saved selection without prompts,
 * and otherwise the user's choice, which starts from the saved selection.
 * Every plugin is selected when none was saved, or when the prompt starts
 * from a saved selection it can't read.
 */
export const selectManagedPlugins = async ({
  nonInteractive,
  saved,
}: {
  readonly nonInteractive: boolean;
  readonly saved: string | undefined;
}): Promise<readonly ManagedPluginId[]> => {
  if (nonInteractive) return parseSaved(saved);
  // A saved selection that can't be read is asked again, not refused.
  let initial: readonly ManagedPluginId[] = MANAGED_PLUGIN_IDS;
  try {
    initial = parseSaved(saved);
  } catch (error) {
    p.log.warn(
      `${error instanceof Error ? error.message : String(error)} Select the plugins again.`,
    );
  }
  const selected = await p.multiselect<ManagedPluginId>({
    message: "Which plugins should the server run? (space to toggle)",
    options: MANAGED_PLUGIN_IDS.map((id) => ({ value: id, ...LABELS[id] })),
    initialValues: [...initial],
    required: false,
  });
  if (p.isCancel(selected)) {
    process.exit(1);
  }
  return MANAGED_PLUGIN_IDS.filter((id) => selected.includes(id));
};

/** The order `hot-updater.config.ts` lists the plugins in. */
const CONFIG_ORDER = [
  "apiKeys",
  "insights",
  "remoteConfig",
] as const satisfies readonly ManagedPluginId[];

/**
 * `plugins` of the config scaffold for the plugins the managed server runs:
 * their factories from `hot-updater/plugins`, or an empty list.
 */
export const managedPluginsConfig = (
  ids: readonly ManagedPluginId[] = MANAGED_PLUGIN_IDS,
): ProviderConfig => {
  const named = CONFIG_ORDER.filter((id) => ids.includes(id));
  return {
    imports: named.length === 0 ? [] : [{ pkg: "hot-updater/plugins", named }],
    configString: `[${named.map((id) => `${id}()`).join(", ")}]`,
  };
};

export {
  formatManagedPlugins,
  MANAGED_PLUGIN_IDS,
  type ManagedPluginId,
  parseManagedPlugins,
};
