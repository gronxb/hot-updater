import { loadConfig } from "@hot-updater/cli-tools";

import { generateFingerprints } from "../../utils/fingerprint";
import { type LoadedServer, loadServer } from "../../utils/loadServer";

type Fingerprints = Awaited<ReturnType<typeof generateFingerprints>>;

/**
 * What one doctor run shares between its checks, its repairs, and the
 * checks after them. The server is loaded once and closed once: the config
 * opens its database once, so closing it before a later check would leave
 * that check a closed database.
 */
export interface DoctorContext {
  readonly cwd: string;
  /** The server hot-updater.config.ts describes; null when it names no database. */
  server(): Promise<LoadedServer | null>;
  /**
   * The project's fingerprints, computed once: a repair writes only
   * fingerprint.json and native hash entries, which are no fingerprint input.
   */
  fingerprints(): Promise<Fingerprints>;
  /** Closes the server, if the run loaded it. */
  dispose(): Promise<void>;
}

export const createDoctorContext = (cwd: string): DoctorContext => {
  let server: Promise<LoadedServer | null> | undefined;
  let fingerprints: Promise<Fingerprints> | undefined;
  return {
    cwd,
    server: () =>
      (server ??= loadConfig(null).then((config) =>
        config.database === undefined ? null : loadServer(config),
      )),
    fingerprints: () => (fingerprints ??= generateFingerprints()),
    dispose: async () => {
      const loaded = await server?.catch(() => null);
      await loaded?.dispose().catch(() => undefined);
    },
  };
};
