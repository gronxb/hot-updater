import { sqlProviders, type ORMSQLProvider } from "../db/types";

/** The provider an adapter was given, when Hot Updater's SQL core runs on it. */
export const checkSqlProvider = <TProvider extends ORMSQLProvider>(
  adapter: string,
  provider: TProvider,
): TProvider => {
  if (!(sqlProviders as readonly string[]).includes(provider)) {
    throw new Error(
      `${adapter}: provider "${String(provider)}" is not supported. Use ${sqlProviders.map((name) => `"${name}"`).join(", ")}; CockroachDB and SQL Server were dropped in 1.0.`,
    );
  }
  return provider;
};
