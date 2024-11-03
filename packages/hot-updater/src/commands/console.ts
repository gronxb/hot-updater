import { serve } from "@hono/node-server";

import app from "@hot-updater/console";

export const openConsole = () => {
  serve(
    {
      fetch: app.fetch,
      port: 1422,
    },
    (info) => {
      console.log(`Server running on port ${info.port}`);
    },
  );
};
