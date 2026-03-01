/**
 * Manual smoke entry for Cloudflare Worker style runtime.
 * Run with your own worker harness (wrangler/miniflare).
 */
import { hdiff } from "../../dist/index.js";

export default {
  async fetch() {
    const base = new Uint8Array([0]); // replace with real HBC bytes in your harness
    const next = new Uint8Array([0]); // replace with real HBC bytes in your harness
    try {
      const patch = await hdiff(base, next);
      return new Response(`patch bytes: ${patch.byteLength}`, { status: 200 });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
