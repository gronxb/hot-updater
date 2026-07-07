import { createServerFn } from "@tanstack/react-start";

import { withConsoleAuth } from "./auth";

export const getConfig = createServerFn().handler(async () =>
  withConsoleAuth(async () => {
    try {
      const { prepareConfig } = await import("../server/config.server");
      const { config } = await prepareConfig();
      return { console: config.console };
    } catch (error) {
      console.error("Error during config retrieval:", error);
      throw error;
    }
  }),
);

export const getCapabilities = createServerFn().handler(async () =>
  withConsoleAuth(async () => {
    try {
      const { prepareConfig } = await import("../server/config.server");
      const { createConsoleCapabilities } =
        await import("../server/capabilities.server");
      const { databasePlugin, storagePlugin } = await prepareConfig();

      return createConsoleCapabilities({ databasePlugin, storagePlugin });
    } catch (error) {
      console.error("Error during capability retrieval:", error);
      throw error;
    }
  }),
);

export const getChannels = createServerFn().handler(async () =>
  withConsoleAuth(async () => {
    try {
      const { prepareConfig } = await import("../server/config.server");
      const { requireConsoleOperation } =
        await import("../server/capabilities.server");
      const { databasePlugin, storagePlugin } = await prepareConfig();
      requireConsoleOperation(
        { databasePlugin, storagePlugin },
        "readChannels",
      );
      const channels = await databasePlugin.getChannels();
      return channels ?? [];
    } catch (error) {
      console.error("Error during channel retrieval:", error);
      throw error;
    }
  }),
);

export const getConfigLoaded = createServerFn().handler(async () =>
  withConsoleAuth(async () => {
    try {
      const { isConfigLoaded } = await import("../server/config.server");
      const configLoaded = isConfigLoaded();
      return { configLoaded };
    } catch (error) {
      console.error("Error during config loaded retrieval:", error);
      throw error;
    }
  }),
);
