/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.json`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { getUpdateInfo } from "./getUpdateInfo";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    
    const bundleId = request.headers.get("x-bundle-id") as string;
    const appPlatform = request.headers.get("x-app-platform") as "ios" | "android";
    const appVersion = request.headers.get("x-app-version") as string;

    if (!bundleId || !appPlatform || !appVersion) {
      return new Response(JSON.stringify({ error: "Missing bundleId, appPlatform, or appVersion" }), { status: 400 });
    }
    
    const updaterInfo = await getUpdateInfo(env, appPlatform, appVersion, bundleId);
    return new Response(JSON.stringify(updaterInfo));
  },
} satisfies ExportedHandler<Env>;
