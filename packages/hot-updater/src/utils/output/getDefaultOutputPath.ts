import { getCwd } from "@hot-updater/cli-tools";
import path from "path";

export const getDefaultOutputPath = () => {
  return path.join(getCwd(), ".hot-updater", "output");
};
