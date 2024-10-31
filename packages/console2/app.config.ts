import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  vite: {
    ssr: {
      external: ["@hot-updater/plugin-core"],
    },
  },
});
