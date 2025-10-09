import { printBanner as _printBanner } from "@hot-updater/plugin-core";
import { version } from "@/packageJson";

export const printBanner = () => {
  _printBanner(version);
};
