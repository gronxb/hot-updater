import fs from "node:fs/promises";
import path from "node:path";

import {
  createStorageDownloadUrl,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
} from "../../../plugins/plugin-core/dist/index.mjs";

export const localFsStorage = (options) => {
  const objectPath = (key) => path.join(options.directory, key);
  const getDownloadUrl = createStorageDownloadUrl(options.signingKey);
  const parse = (storageUri) => {
    const parsed = parseStorageUri(storageUri, "storage");
    if (parsed.bucket !== "my-app") {
      throw new Error(
        `Bucket name mismatch: expected "my-app", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "local-fs",
    protocol: "storage",
    async put({ key, body, contentType }) {
      const storageUri = createStorageUri({
        bucket: "my-app",
        key,
        protocol: "storage",
      });
      const file = objectPath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      await fs.writeFile(file, bytes);
      await fs.writeFile(
        `${file}.meta.json`,
        JSON.stringify({ contentType, storageUri }),
      );
      return { storageUri };
    },
    async get({ storageUri }) {
      const parsed = parse(storageUri);
      const file = objectPath(parsed.key);
      try {
        const body = await fs.readFile(file);
        const meta = JSON.parse(await fs.readFile(`${file}.meta.json`, "utf8"));
        return {
          response: new Response(body, {
            headers: {
              "content-length": String(body.byteLength),
              "content-type": meta.contentType ?? "application/octet-stream",
            },
          }),
        };
      } catch (error) {
        if (error.code === "ENOENT") return { response: null };
        throw error;
      }
    },
    getDownloadUrl,
    async exists({ storageUri }) {
      const parsed = parse(storageUri);
      try {
        await fs.access(objectPath(parsed.key));
        return { exists: true };
      } catch {
        return { exists: false };
      }
    },
    async delete({ storageUri }) {
      const parsed = parse(storageUri);
      const file = objectPath(parsed.key);
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.meta.json`, { force: true });
      return { deleted: true };
    },
  });
};
