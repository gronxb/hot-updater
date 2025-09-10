import { fumadb } from "fumadb";
import type { InferFumaDB } from "fumadb";
import { kyselyAdapter } from "fumadb/adapters/kysely";
import { v1 } from "../schema/v1";

const HotUpdaterDB = fumadb({
  namespace: "hot-updater",
  schemas: [v1],
});

export function hotUpdater(client: InferFumaDB<typeof HotUpdaterDB>) {
  return {
    async getBundleById(id: string) {
      // get schema version
      const version = await client.version();
      const orm = client.orm(version);
      const result = await orm.findFirst("bundles", {
        select: [
          "id",
          "platform",
          "should_force_update",
          "enabled",
          "file_hash",
          "git_commit_hash",
          "message",
          "channel",
          "storage_uri",
          "target_app_version",
          "fingerprint_hash",
          "metadata",
        ],
        where: (b) => b.and(b.isNotNull("id"), b("id", "=", id)),
      });
      return result;
    },
  };
}

const hotUpdaterAPI = hotUpdater(
  HotUpdaterDB.client(
    kyselyAdapter({
      provider: "postgresql",
      db: kysely,
    }),
  ),
);
