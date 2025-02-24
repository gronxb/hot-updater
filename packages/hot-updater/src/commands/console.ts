import { serve } from "@hono/node-server";
import app from "@hot-updater/console";
import { type Config, loadConfig } from "@hot-updater/plugin-core";

import type { AddressInfo } from "net";

export const CONSOLE_DEFAULT_PORT = 1422;

export const getConsolePort = async (config?: Config) => {
  let $config: Config | undefined | null = config;
  if (!$config) {
    $config = await loadConfig({
      platform: "console",
    });
  }
  return $config?.console?.port ?? CONSOLE_DEFAULT_PORT;
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
