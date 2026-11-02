import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";
import {
  type SchemaMigrationStatus,
  schemaMigrationOf,
} from "./schema-migration";

/**
 * Whether the schema fence refuses the console's database, and what it
 * found: one read through core, which the console makes only after a page's
 * read failed. Null when the read passes or fails for another reason, which
 * the page reports itself.
 */
export const getSchemaMigrationRpc = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .handler(async (): Promise<SchemaMigrationStatus | null> => {
    const { prepareConfig } = await import("./server/config.server");
    const { config, core } = await prepareConfig();
    try {
      await core.listChannels();
      return null;
    } catch (error) {
      return schemaMigrationOf(error, config.plugins);
    }
  });
