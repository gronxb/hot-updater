import fs from "fs";
import os from "os";
import path from "path";
import toml from "toml";

import xdgAppPaths from "xdg-app-paths";

const isDirectory = (configPath: string) => {
  try {
    return fs.statSync(configPath).isDirectory();
  } catch (error) {
    return false;
  }
};

const getGlobalWranglerConfigPath = () => {
  const configDir = xdgAppPaths(".wrangler").config();
  const legacyConfigDir = path.join(os.homedir(), ".wrangler");

  if (isDirectory(legacyConfigDir)) {
    return legacyConfigDir;
  }

  return configDir;
};

export const getWranglerLoginAuthToken = (): {
  oauth_token: string;
  expiration_time: string;
  refresh_token: string;
  scopes: string[];
} => {
  try {
    const wranglerConfigPath = getGlobalWranglerConfigPath();
    const wranglerConfig = fs.readFileSync(
      path.join(wranglerConfigPath, "config", "default.toml"),
      "utf8",
    );
    return toml.parse(wranglerConfig);
  } catch (error) {
    throw new Error("'npx wrangler login' is required to use this command");
  }
};
