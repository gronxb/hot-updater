export * from "./vercelBlobStorage";
/**
 * The managed Vercel database: init's config and the prebuilt Function store
 * metadata in Postgres, so a Vercel project installs this one package.
 */
export { postgres, type PostgresConfig } from "@hot-updater/postgres";
