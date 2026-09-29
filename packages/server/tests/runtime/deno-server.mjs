import { hotUpdater } from "./fixture.mjs";

const port = Number(Deno.args[Deno.args.indexOf("--port") + 1]);
Deno.serve({ hostname: "127.0.0.1", port }, (request) =>
  hotUpdater.handlers.client(request),
);
