import { createServer } from "http";
import { a } from "@hot-updater/console2";

export const openConsole = () => {
  createServer(a).listen(1422);
};
