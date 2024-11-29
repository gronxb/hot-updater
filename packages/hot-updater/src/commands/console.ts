import { serve } from "@hono/node-server";
import app from "@hot-updater/console";
import picocolors from "picocolors";

export const openConsole = () => {
  serve(
    {
      fetch: app.fetch,
      port: 1422,
    },
    (info) => {
      console.log(
        `Server running on ${picocolors.magenta(
          picocolors.underline(`http://localhost:${info.port}`),
        )}`,
      );
    },
  );
};
