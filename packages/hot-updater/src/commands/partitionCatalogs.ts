import {
  enableReleaseCatalogPartitioning,
  loadConfig,
  p,
  PartitioningEnableError,
} from "@hot-updater/cli-tools";

import { loadServer } from "@/utils/loadServer";

import { printBanner } from "../utils/printBanner";
import { confirmMutation, safeDispose } from "./release";

/**
 * `db partition-catalogs`: asks the server to turn release catalog
 * partitioning on. The server checks its partitions table with its own
 * credentials first; this command never writes the switch. Over
 * `standaloneRepository`, it calls the admin route; over the server's own
 * database, such as a managed provider's, it stores a request token there
 * and calls the server's client route at `--server-url`.
 */
export const handlePartitionCatalogs = async (options: {
  readonly serverUrl?: string;
  readonly yes?: boolean;
}): Promise<void> => {
  printBanner();
  const server = await loadServer(await loadConfig(null));
  try {
    await confirmMutation(
      "Every server must run Hot Updater 1.2.0 first. Partition release catalogs?",
      options.yes,
    );
    const { changed } = await enableReleaseCatalogPartitioning({
      server,
      ...(options.serverUrl === undefined
        ? {}
        : { serverUrl: options.serverUrl }),
    });
    p.log.success(
      changed
        ? "Release catalogs are partitioned from now on.\nEach app-version scope converts on its next write."
        : "Release catalogs are already partitioned.",
    );
  } catch (error) {
    if (!(error instanceof PartitioningEnableError)) throw error;
    p.log.error(`Partitioning stays off: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await safeDispose(server);
  }
};
