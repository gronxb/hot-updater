import { printBanner as _printBanner } from "@hot-updater/cli-tools";
import { version } from "@/packageJson";

export const printBanner = () => {
  _printBanner(version);
};
