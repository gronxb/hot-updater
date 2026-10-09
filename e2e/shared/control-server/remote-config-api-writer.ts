import type { RemoteConfigApi } from "@hot-updater/plugin-remote-config/server";

import type { RemoteConfigAdminClient } from "./remote-config-admin.ts";

/**
 * Remote Config written in process over the config's database, as the CLI
 * and the Console write a managed server's: managed servers serve no admin
 * routes. Like the admin client, it publishes and rolls back against the
 * active version, so earlier scenarios' versions never matter.
 */
export const createRemoteConfigApiWriter = (
  api: Pick<RemoteConfigApi, "getActive" | "publish" | "rollback">,
): RemoteConfigAdminClient => ({
  publish: async ({ template, description }) => {
    const { version } = await api.getActive();
    const result = await api.publish({
      template,
      baseVersion: version,
      ...(description === undefined ? {} : { description }),
    });
    if (result.status === "conflict") {
      throw new Error(
        `Remote Config version ${result.currentVersion} was published after version ${version}.`,
      );
    }
    return result.version.version;
  },
  rollback: async (source) => {
    const { version } = await api.getActive();
    const result = await api.rollback({
      version: source,
      baseVersion: version,
    });
    if (result.status === "not_found") {
      throw new Error(`Remote Config version ${source} does not exist.`);
    }
    if (result.status === "conflict") {
      throw new Error(
        `Remote Config version ${result.currentVersion} was published after version ${version}.`,
      );
    }
    return result.version.version;
  },
});
