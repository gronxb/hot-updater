import type { SqlDialect } from "@hot-updater/plugin-core";

/** The dialects Hot Updater's SQL core runs on. */
const sqlProviders: readonly SqlDialect[] = ["sqlite", "mysql", "postgresql"];

/** The provider an adapter was given, when Hot Updater's SQL core runs on it. */
export const checkSqlProvider = <TProvider extends SqlDialect>(
  adapter: string,
  provider: TProvider,
): TProvider => {
  if (!(sqlProviders as readonly string[]).includes(provider)) {
    throw new Error(
      `${adapter}: provider "${String(provider)}" is not supported. Use ${sqlProviders.map((name) => `"${name}"`).join(", ")}.`,
    );
  }
  return provider;
};
