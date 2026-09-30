import type { HotUpdaterHandlers } from "@hot-updater/server";
import { Hono } from "hono";

import { supabaseDatabase as edgeDatabase } from "./supabaseDatabase";
import { supabaseEdgeFunctionStorage } from "./supabaseEdgeFunctionStorage";

export { plugins } from "./plugins";

/** What init bakes into the managed Edge Function when it bundles it. */
declare const HotUpdater: {
  readonly BUCKET_NAME: string;
  readonly FUNCTION_NAME: string;
};

/** The Supabase Edge Runtime's Deno. */
declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

/** The project's connection as the Edge Runtime sets it for its functions. */
const connection = () => ({
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
});

/*
 * The managed Edge Function runs the project's server definition with this
 * module in place of `@hot-updater/supabase`: the definition's database and
 * storage use the function's own service role and the bucket init set up,
 * and the credentials it passes, which are the CLI's, go unused.
 */

/** The server definition's database in the managed Edge Function. */
export const supabaseDatabase = (_config?: unknown) =>
  edgeDatabase(connection());

/** The server definition's storage in the managed Edge Function: the bucket init set up. */
export const supabaseStorage = (_config?: unknown) =>
  supabaseEdgeFunctionStorage({
    ...connection(),
    bucketName: HotUpdater.BUCKET_NAME,
  });

/** Serves the server definition's client routes as the managed Edge Function. */
export const serveManagedEdgeFunction = (hotUpdater: {
  readonly handlers: Pick<HotUpdaterHandlers, "client">;
}) => {
  const app = new Hono().basePath(`/${HotUpdater.FUNCTION_NAME}`);
  app.get("/ping", (c) => c.text("pong"));
  app.mount("/", (request: Request) => hotUpdater.handlers.client(request));
  Deno.serve(app.fetch);
};
