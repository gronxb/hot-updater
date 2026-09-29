/**
 * The console's features and the server plugin each one needs. The server is
 * the source of truth: the console serves a feature only when the server runs
 * its plugin, and against a self-hosted server (`standaloneRepository`) only
 * the features its admin API serves (`remote`); the rest read the database.
 * Navigation, route guards, and server functions all read this registry.
 */
export const consoleFeatures = {
  /** Event history and installation lookups, which the admin API serves too. */
  insights: { plugin: "insights", remote: true },
  /** App usage, distribution, and release activity, read from the database. */
  insightsAnalytics: { plugin: "insights", remote: false },
  /** API key management: `apiKeys()` mounts no admin routes to manage them. */
  apiKeys: { plugin: "apiKeys", remote: false },
} as const satisfies Readonly<
  Record<string, { readonly plugin: string; readonly remote: boolean }>
>;

export type ConsoleFeature = keyof typeof consoleFeatures;

/** A plugin some feature needs, by the id the server assembles it under. */
export type ConsolePlugin = (typeof consoleFeatures)[ConsoleFeature]["plugin"];

/** Whether each feature is on. */
export type ConsoleFeatures = Readonly<Record<ConsoleFeature, boolean>>;

/** What the console serves, as its client reads it. */
export type ConsoleFeatureSet = {
  readonly features: ConsoleFeatures;
  /** Whether the console reaches a self-hosted server through its admin API. */
  readonly remote: boolean;
};

const featureIds = Object.keys(consoleFeatures) as ConsoleFeature[];

/** The features on for the plugins a server runs, from where the console reads them. */
export const resolveConsoleFeatures = (
  plugins: readonly string[],
  { remote }: { readonly remote: boolean },
): ConsoleFeatures => {
  const installed = new Set(plugins);
  return Object.fromEntries(
    featureIds.map((feature) => {
      const { plugin, remote: servedRemotely } = consoleFeatures[feature];
      return [feature, installed.has(plugin) && (servedRemotely || !remote)];
    }),
  ) as Record<ConsoleFeature, boolean>;
};

/** Why a feature is off: its plugin is missing, or it reads a database the console does not open. */
export const unavailableReason = (
  feature: ConsoleFeature,
  { remote }: { readonly remote: boolean },
): "plugin" | "remote" =>
  remote && !consoleFeatures[feature].remote ? "remote" : "plugin";

/**
 * A server function refused a feature the console does not serve: the
 * features' 404. The client recognizes it by `name`, which survives
 * serialization where the class does not.
 */
export class ConsoleFeatureUnavailableError extends Error {
  override readonly name = "ConsoleFeatureUnavailableError";
  readonly status = 404;

  constructor(
    readonly feature: ConsoleFeature,
    { remote }: { readonly remote: boolean },
  ) {
    super(
      unavailableReason(feature, { remote }) === "remote"
        ? "The console reads this from the database, and it reaches a self-hosted server through its admin API instead."
        : `The server runs without the ${consoleFeatures[feature].plugin}() plugin.`,
    );
  }
}

export const isConsoleFeatureUnavailableError = (
  error: unknown,
): error is Error & { readonly feature: ConsoleFeature } =>
  error instanceof Error &&
  error.name === "ConsoleFeatureUnavailableError" &&
  featureIds.includes(Reflect.get(error, "feature") as ConsoleFeature);
