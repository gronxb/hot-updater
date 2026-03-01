import { hdiff } from "../../../dist/worker.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    if (url.pathname !== "/demo/patch" || request.method !== "GET") {
      return Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404 });
    }

    try {
      const base = await readFixtureAsset(env, request.url, "/one/index.ios.bundle.hbc");
      const next = await readFixtureAsset(env, request.url, "/two/index.ios.bundle.hbc");
      const patch = await hdiff(base, next);
      const hash = await sha256Hex(patch);

      return new Response(patch, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="one-to-two.bsdiff"',
          "x-hdiff-patch-bytes": String(patch.byteLength),
          "x-hdiff-patch-sha256": hash,
        },
      });
    } catch (error) {
      const err = error;
      return Response.json(
        {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  },
};

async function readFixtureAsset(env, requestUrl, assetPath) {
  const response = await env.ASSETS.fetch(new URL(assetPath, requestUrl));
  if (!response.ok) {
    throw new Error(`Failed to load fixture asset ${assetPath}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}
