import { loadConfig, nonInteractiveReason } from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import { generateFingerprints } from "../../utils/fingerprint";
import { type LoadedServer, loadServer } from "../../utils/loadServer";
import { type ManagedDeployment, readManagedDeployment } from "./managed";

type Fingerprints = Awaited<ReturnType<typeof generateFingerprints>>;

/**
 * What one doctor run shares between its checks, its repairs, and the
 * checks after them. The server is loaded once and closed once: the config
 * opens its database once, so closing it before a later check would leave
 * that check a closed database.
 */
export interface DoctorContext {
  readonly cwd: string;
  /** Repairs never prompt: `--json`, or no terminal to answer in. */
  readonly nonInteractive: boolean;
  /** The server hot-updater.config.ts describes; null when it names no database. */
  server(): Promise<LoadedServer | null>;
  /**
   * The deployment `hot-updater init` manages for this project, whose server
   * init redeploys; null for a server of the project's own, or when the
   * config does not load.
   */
  managed(): Promise<ManagedDeployment | null>;
  /**
   * The project's fingerprints, computed once: a repair writes only
   * fingerprint.json and native hash entries, which are no fingerprint input.
   */
  fingerprints(): Promise<Fingerprints>;
  /** Closes the server, if the run loaded it. */
  dispose(): Promise<void>;
}

export const createDoctorContext = (
  cwd: string,
  nonInteractive = nonInteractiveReason() !== undefined,
): DoctorContext => {
  let server: Promise<LoadedServer | null> | undefined;
  let fingerprints: Promise<Fingerprints> | undefined;
  let managed: Promise<ManagedDeployment | null> | undefined;
  const loadedServer = () =>
    (server ??= loadConfig(null).then((config) =>
      config.database === undefined ? null : loadServer(config),
    ));
  return {
    cwd,
    nonInteractive,
    server: loadedServer,
    managed: () =>
      (managed ??= loadedServer().then(
        (loaded) =>
          loaded === null || isRemoteDatabase(loaded.database)
            ? null
            : readManagedDeployment(cwd, loaded.database.name),
        () => null,
      )),
    fingerprints: () => (fingerprints ??= generateFingerprints()),
    dispose: async () => {
      const loaded = await server?.catch(() => null);
      await loaded?.dispose().catch(() => undefined);
    },
  };
};
