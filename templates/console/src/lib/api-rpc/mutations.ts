import type { Bundle } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { withConsoleAuth } from "./auth";

type UpdateBundleInput = {
  bundleId: string;
  bundle: Partial<Bundle>;
};

type PromoteBundleInput = {
  action: "copy" | "move";
  bundleId: string;
  nextBundleId?: string;
  targetChannel: string;
};

type DeleteBundleInput = {
  bundleId: string;
};

export const updateBundle = createServerFn({ method: "POST" })
  .inputValidator((input: UpdateBundleInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "updateBundle",
        );
        await databasePlugin.updateBundle(data.bundleId, data.bundle);
        await databasePlugin.commitBundle();
        const updatedBundle = await databasePlugin.getBundleById(data.bundleId);

        if (!updatedBundle) {
          throw new Error("Updated bundle not found");
        }

        return { success: true, bundle: updatedBundle };
      } catch (error) {
        console.error("Error during bundle update:", error);
        throw error;
      }
    }),
  );

export const promoteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: PromoteBundleInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { promoteBundle: promoteBundleWithConfig } =
          await import("@hot-updater/cli-tools");
        const { requireConsoleOperation, requireNodeStorageOperation } =
          await import("../server/capabilities.server");
        const { config, databasePlugin, storagePlugin } = await prepareConfig();
        const promotionStoragePlugin =
          data.action === "copy"
            ? requireNodeStorageOperation(
                { databasePlugin, storagePlugin },
                "promoteBundleCopy",
              )
            : null;
        if (data.action === "move") {
          requireConsoleOperation(
            { databasePlugin, storagePlugin },
            "promoteBundleMove",
          );
        }
        const bundle = await promoteBundleWithConfig(data, {
          config,
          databasePlugin,
          storagePlugin: promotionStoragePlugin,
        });

        return { success: true, bundle };
      } catch (error) {
        console.error("Error during bundle promotion:", error);
        throw error;
      }
    }),
  );

export const createBundle = createServerFn({ method: "POST" })
  .inputValidator((input: Bundle) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { requireConsoleOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        requireConsoleOperation(
          { databasePlugin, storagePlugin },
          "createBundle",
        );
        await databasePlugin.appendBundle(data);
        await databasePlugin.commitBundle();
        return { success: true, bundleId: data.id };
      } catch (error) {
        console.error("Error during bundle creation:", error);
        throw error;
      }
    }),
  );

export const deleteBundle = createServerFn({ method: "POST" })
  .inputValidator((input: DeleteBundleInput) => input)
  .handler(async ({ data }) =>
    withConsoleAuth(async () => {
      try {
        const { prepareConfig } = await import("../server/config.server");
        const { deleteBundle: deleteBundleWithStorage } =
          await import("../server/deleteBundle");
        const { requireNodeStorageOperation } =
          await import("../server/capabilities.server");
        const { databasePlugin, storagePlugin } = await prepareConfig();
        const nodeStoragePlugin = requireNodeStorageOperation(
          { databasePlugin, storagePlugin },
          "deleteBundle",
        );

        await deleteBundleWithStorage(data, {
          databasePlugin,
          storagePlugin: nodeStoragePlugin,
          waitForStorageCleanup: false,
        });

        return { success: true };
      } catch (error) {
        console.error("Error during bundle deletion:", error);
        throw error;
      }
    }),
  );
