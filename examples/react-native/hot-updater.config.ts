import { metro } from "@hot-updater/metro";
import { defineConfig } from "hot-updater";

export default defineConfig({
  updateServer: "",
  build: metro(),
  deploy: () => {},
});
