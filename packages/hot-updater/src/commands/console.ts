import { serve } from "@hono/node-server";
import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import app from "@hot-updater/console";

import type { AddressInfo } from "net";

export const getConsolePort = async (config?: ConfigResponse) => {
  if (config?.console.port) {
    return config.console.port;
  }

  const $config = await loadConfig(null);
  return $config.console.port;
};

export const openConsole = async (
  port: number,
  listeningListener?: ((info: AddressInfo) => void) | undefined,
) => {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    listeningListener,
  );
};
