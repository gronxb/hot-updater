import { getCwd } from "@hot-updater/plugin-core";
import path from "path";

export const getDefaultOutputPath = () => {
  return path.join(getCwd(), ".hot-updater", "output");
};
