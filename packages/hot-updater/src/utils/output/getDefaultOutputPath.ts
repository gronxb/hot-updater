import path from "path";
import { getCwd } from "@hot-updater/plugin-core";

export const getDefaultOutputPath = () => {
  return path.join(getCwd(), ".hot-updater", "output");
};
