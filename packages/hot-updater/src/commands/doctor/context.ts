import { loadConfig } from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import { generateFingerprints } from "../../utils/fingerprint";
import { type LoadedServer, loadServer } from "../../utils/loadServer";
import { providerOfDatabase } from "../initProviders";
import { type ManagedDeployment, readManagedDeployment } from "./managed";
import {
  findScaffoldDeployments,
  type ScaffoldDeployment,
  type ScaffoldUpgrade,
  scaffoldUpgradeFor,
} from "./scaffoldRecords";

type Fingerprints = Awaited<ReturnType<typeof generateFingerprints>>;

/** The resource a database reaches, as its factory marks it (CLAUDE.md). */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/** The brand Hot Updater's own plugin factories set, read as the server reads it. */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/**
 * What one doctor run shares between its checks. The server is loaded once
 * and closed once: the config opens its database once, so closing it before
 * a later check would leave that check a closed database.
 */
export interface DoctorContext {
  readonly cwd: string;
  /** The server hot-updater.config.ts describes; null when it names no database. */
  server(): Promise<LoadedServer | null>;
  /**
   * The deployment `hot-updater init` manages for this project, whose server
   * init redeploys; null for a server of the project's own, or when the
   * config does not load.
   */
  managed(): Promise<ManagedDeployment | null>;
  /** The deployments agent infrastructure scaffolds in the default output record. */
  scaffolds(): Promise<ScaffoldDeployment[]>;
  /**
   * The scaffold upgrade of the config's database's provider, when a
   * scaffold records its deployment: it takes the place of init's command.
   */
  scaffoldUpgrade(): Promise<ScaffoldUpgrade | null>;
  /** The project's fingerprints, computed once for every check that reads them. */
  fingerprints(): Promise<Fingerprints>;
  /** Closes the server, if the run loaded it. */
  dispose(): Promise<void>;
}

export const createDoctorContext = (cwd: string): DoctorContext => {
  let server: Promise<LoadedServer | null> | undefined;
  let fingerprints: Promise<Fingerprints> | undefined;
  let managed: Promise<ManagedDeployment | null> | undefined;
  let scaffolds: Promise<ScaffoldDeployment[]> | undefined;
  const scaffoldRecords = () => (scaffolds ??= findScaffoldDeployments(cwd));
  const loadedServer = () =>
    (server ??= loadConfig(null).then((config) =>
      config.database === undefined ? null : loadServer(config),
    ));
  return {
    cwd,
    server: loadedServer,
    managed: () =>
      (managed ??= loadedServer().then(
        (loaded) =>
          loaded === null || isRemoteDatabase(loaded.database)
            ? null
            : readManagedDeployment(cwd, loaded.database, loaded.plugins),
        () => null,
      )),
    scaffolds: scaffoldRecords,
    scaffoldUpgrade: async () => {
      const loaded = await loadedServer().catch(() => null);
      if (loaded === null || isRemoteDatabase(loaded.database)) return null;
      const provider = providerOfDatabase(loaded.database.name);
      // The scaffold's server runs only the official plugins: a config with
      // another keeps its own server's path, as for init.
      if (
        provider === undefined ||
        loaded.plugins.some((plugin) => Reflect.get(plugin, OFFICIAL) !== true)
      ) {
        return null;
      }
      const target: unknown = Reflect.get(loaded.database, DATABASE_TARGET);
      return scaffoldUpgradeFor(
        await scaffoldRecords(),
        provider,
        typeof target === "string" ? target : undefined,
      );
    },
    fingerprints: () => (fingerprints ??= generateFingerprints()),
    dispose: async () => {
      const loaded = await server?.catch(() => null);
      await loaded?.dispose().catch(() => undefined);
    },
  };
};
