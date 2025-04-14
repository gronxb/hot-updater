import { version } from "@/packageJson";
import { printBanner as _printBanner } from "@hot-updater/plugin-core";

export const printBanner = () => {
  _printBanner(version);
};
