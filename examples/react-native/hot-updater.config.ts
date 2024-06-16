import { defineConfig } from "hot-updater";
import { metro } from "hot-updater/metro";

export default defineConfig({
  deploy: [metro()],
});
