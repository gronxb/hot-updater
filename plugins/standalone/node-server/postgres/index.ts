import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";

import { PGlite } from "@electric-sql/pglite";
import {
  PGliteAdapter,
  getUpdateInfo,
  prepareSql,
} from "@hot-updater/postgres";

import { Hono } from "hono";
import { logger } from "hono/logger";

const pglite = new PGlite("memory");

/**
 * Run only once to register tables.
 */
pglite.exec(await prepareSql());

/*
 * If you want to use pg.Pool, uncomment the following code.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { PgPoolAdapter } from "@hot-updater/postgres";
 *
 * const pool = new PgPoolAdapter(
 *   new pg.Pool({
 *     host: process.env.HOT_UPDATER_POSTGRES_HOST!,
 *     port: process.env.HOT_UPDATER_POSTGRES_PORT!,
 *     user: process.env.HOT_UPDATER_POSTGRES_USER!,
 *     password: process.env.HOT_UPDATER_POSTGRES_PASSWORD!,
 *     database: process.env.HOT_UPDATER_POSTGRES_DATABASE!,
 *   }),
 * );
 * ```
 */
const pool = new PGliteAdapter(pglite);

const app = new Hono();

app.use(logger());

app.get("/ping", (c) => c.text("pong"));

app.get("/api/check-update", async (c) => {
  try {
    const bundleId = c.req.header("x-bundle-id") as string;
    const appPlatform = c.req.header("x-app-platform") as "ios" | "android";
    const appVersion = c.req.header("x-app-version") as string;
    const minBundleId = c.req.header("x-min-bundle-id") as string | undefined; // nil
    const channel = c.req.header("x-channel") as string | undefined; // production

    if (!bundleId || !appPlatform || !appVersion) {
      return c.json(
        { error: "Missing bundleId, appPlatform, or appVersion" },
        400,
      );
    }

    const updateInfo = await getUpdateInfo(pool, {
      platform: appPlatform,
      bundleId,
      appVersion,
      minBundleId,
      channel,
    });
    if (!updateInfo) {
      return c.json(null);
    }

    const appUpdateInfo = await withJwtSignedUrl({
      data: updateInfo,
      reqUrl: c.req.url,
      jwtSecret: process.env.JWT_SECRET!,
    });

    return c.json(appUpdateInfo, 200);
  } catch (e) {
    console.error(e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// API to retrieve bundle list
app.get("/bundles", async (c) => {
  try {
    const result = await pool.query("SELECT * FROM bundles");
    const bundles = result.rows;
    return c.json(bundles, 200);
  } catch (e) {
    console.error(e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// API to retrieve a specific bundle
app.get("/bundles/:bundleId", async (c) => {
  try {
    const bundleId = c.req.param("bundleId");
    const result = await pool.query("SELECT * FROM bundles WHERE id = $1", [
      bundleId,
    ]);
    const bundle = result.rows[0];

    if (!bundle) {
      return c.json(null, 404);
    }

    return c.json(bundle, 200);
  } catch (e) {
    console.error(e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// API to create/update bundles
app.post("/bundles", async (c) => {
  try {
    const bundles = await c.req.json();

    if (!Array.isArray(bundles)) {
      return c.json(
        { error: "Invalid request body. Expected array of bundles." },
        400,
      );
    }

    for (const bundle of bundles) {
      await pool.query(
        "INSERT INTO bundles(id, key, file_hash, platform, target_app_version, should_force_update, enabled, git_commit_hash, message, channel) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO UPDATE SET key = $2, file_hash = $3, platform = $4, target_app_version = $5, should_force_update = $6, enabled = $7, git_commit_hash = $8, message = $9, channel = $10",
        [
          bundle.id,
          bundle.key,
          bundle.fileHash,
          bundle.platform,
          bundle.targetAppVersion,
          bundle.shouldForceUpdate,
          bundle.enabled,
          bundle.gitCommitHash,
          bundle.message,
          bundle.channel,
        ],
      );
    }

    return c.json({ success: true }, 200);
  } catch (e) {
    console.error(e);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  const result = await verifyJwtSignedUrl({
    path: c.req.path,
    token: c.req.query("token"),
    jwtSecret: process.env.JWT_SECRET!,
    handler: async (key) => {
      try {
        return {
          body: Buffer.from("File content"),
          contentType: "application/octet-stream",
        };
      } catch {
        return null;
      }
    },
  });

  if (result.status !== 200) {
    return c.json({ error: result.error }, result.status);
  }

  return c.body(result.responseBody, 200, result.responseHeaders);
});

export default app;
