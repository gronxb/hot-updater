import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { kyselyAdapter } from "../../../packages/server/dist/adapters/kysely.mjs";
import { createMigrator } from "../../../packages/server/dist/db/index.mjs";
import { createHotUpdater } from "../../../packages/server/dist/index.mjs";
import {
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
} from "../../../plugins/plugin-core/dist/index.mjs";

// Task-local service: real persisted PostgreSQL-compatible state and filesystem
// objects, exposed through the existing Hot Updater repository/client handlers.
const serverRequire = createRequire(
  new URL("../../../packages/server/package.json", import.meta.url),
);
const { PGlite } = serverRequire("@electric-sql/pglite");
const { Kysely } = serverRequire("kysely");
const { PGliteDialect } = serverRequire("kysely-pglite-dialect");
const root = fileURLToPath(new URL("../.hot-updater/ota/", import.meta.url));
const objects = path.join(root, "objects");
const port = 18791;
const origin = `http://127.0.0.1:${port}`;
const protocol = "lynx-local";
await fs.mkdir(objects, { recursive: true });
const tokenPath = path.join(root, "admin-token");
try {
  await fs.writeFile(tokenPath, crypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const token = (await fs.readFile(tokenPath, "utf8")).trim();

const storageUri = (key) => createStorageUri({ protocol, bucket: "ota", key });
const keyFromUri = (uri) => {
  const parsed = parseStorageUri(uri, protocol);
  if (parsed.bucket !== "ota") throw new Error("Unknown storage bucket");
  // Revalidate decoded segments; no file operation accepts caller-owned paths.
  storageUri(parsed.key);
  return parsed.key;
};
const filename = (uri) => path.join(objects, keyFromUri(uri));
const readObject = async (uri) => {
  try {
    return new Response(await fs.readFile(filename(uri)), {
      headers: { "content-type": "application/octet-stream" },
    });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const storage = createStoragePlugin({
  name: "lynx-local-filesystem",
  protocol,
  async put({ key, body, contentLength }) {
    const uri = storageUri(key);
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    if (contentLength !== undefined && bytes.length !== contentLength)
      throw new Error("Upload length mismatch");
    const target = filename(uri);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { storageUri: uri };
  },
  async get({ storageUri: uri }) {
    return { response: await readObject(uri) };
  },
  async exists({ storageUri: uri }) {
    try {
      return { exists: (await fs.stat(filename(uri))).isFile() };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw error;
    }
  },
  async delete({ storageUri: uri }) {
    await fs.rm(filename(uri), { force: true });
    return { deleted: true };
  },
  async getDownloadUrl({ storageUri: uri }) {
    return {
      url: `${origin}/files/${keyFromUri(uri).split("/").map(encodeURIComponent).join("/")}`,
    };
  },
});

const postgres = new PGlite(path.join(root, "postgres"));
await postgres.waitReady;
const database = new Kysely({ dialect: new PGliteDialect(postgres) });
const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db: database, provider: "postgresql" }),
  storage: [storage],
  clientAccess: { type: "public" },
});
await (
  await createMigrator(hotUpdater).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  })
).execute();

const route = async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health")
    return Response.json({
      status: "ready",
      pid: process.pid,
      port,
      database: "persisted-pglite",
      storage: "filesystem",
    });
  if (
    /^\/receipts\/[A-Za-z0-9-]+\.json$/.test(url.pathname) &&
    request.method === "GET"
  ) {
    try {
      return new Response(
        await fs.readFile(
          path.join(root, "receipts", path.basename(url.pathname)),
        ),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      );
    } catch (error) {
      if (error.code === "ENOENT")
        return new Response("Not found", { status: 404 });
      throw error;
    }
  }
  if (
    url.pathname.startsWith("/files/") &&
    ["GET", "HEAD"].includes(request.method)
  ) {
    const key = url.pathname
      .slice("/files/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    return (
      (await readObject(storageUri(key))) ??
      new Response("Not found", { status: 404 })
    );
  }
  const admin = url.pathname.startsWith("/hot-updater/admin/");
  const storageRoute = url.pathname.startsWith("/storage/");
  if (
    (admin || storageRoute) &&
    request.headers.get("authorization") !== `Bearer ${token}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (storageRoute) {
    if (url.pathname === "/storage/upload" && request.method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      const key = form.get("key");
      if (!(file instanceof Blob) || typeof key !== "string")
        return new Response("Invalid upload", { status: 400 });
      return Response.json(
        await storage.put({
          key,
          body: file.stream(),
          contentType: file.type,
          contentLength: file.size,
        }),
      );
    }
    const input = await request.json();
    if (url.pathname === "/storage/exists" && request.method === "POST")
      return Response.json(await storage.exists(input));
    if (url.pathname === "/storage/get" && request.method === "POST")
      return (
        (await storage.get(input)).response ??
        new Response("Not found", { status: 404 })
      );
    if (url.pathname === "/storage/delete" && request.method === "DELETE")
      return Response.json(await storage.delete(input));
  }
  if (url.pathname.startsWith("/hot-updater/")) {
    const prefix = admin ? "/hot-updater/admin" : "/hot-updater";
    url.pathname = url.pathname.slice(prefix.length) || "/";
    return (admin ? hotUpdater.handlers.admin : hotUpdater.handlers.client)(
      new Request(url, request),
    );
  }
  return new Response("Not found", { status: 404 });
};

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method,
      headers: incoming.headers,
      ...(["GET", "HEAD"].includes(incoming.method)
        ? {}
        : { body: Readable.toWeb(incoming), duplex: "half" }),
    });
    const response = await route(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(
      incoming.method === "HEAD"
        ? undefined
        : Buffer.from(await response.arrayBuffer()),
    );
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        method: incoming.method,
        path: new URL(request.url).pathname,
        status: response.status,
      }),
    );
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(port, "127.0.0.1", async () => {
  await fs.writeFile(path.join(root, "server.pid"), `${process.pid}\n`);
  console.log(
    JSON.stringify({ status: "listening", origin, root, pid: process.pid }),
  );
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () =>
    server.close(async () => {
      await database.destroy();
      await postgres.close();
      await fs.rm(path.join(root, "server.pid"), { force: true });
      process.exit(0);
    }),
  );
}
