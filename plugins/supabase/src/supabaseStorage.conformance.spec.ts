import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

/**
 * A Supabase Storage bucket behind the supabase-js calls the adapter makes,
 * with the results supabase-js returns. supabase-js puts the name of an
 * upload, a download or a HEAD request in the URL unencoded, and Storage
 * accepts names of ASCII letters, digits and `_/!.*'() &$=@;:+,?-` only.
 * The edge runtime's Docker spec runs the same suite on a Storage server.
 */
const { bucket, objects } = vi.hoisted(() => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const validName = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]+$/;
  /** The name Storage reads from a request URL with `name` in it unencoded. */
  const nameInUrl = (name: string) => {
    try {
      const { pathname } = new URL(`https://project.supabase.co/${name}`);
      return decodeURIComponent(pathname.slice(1));
    } catch {
      return name;
    }
  };
  const invalidKey = (name: string) => ({
    statusCode: "400",
    error: "InvalidKey",
    message: `Invalid key: ${name}`,
  });
  /** A failed download or HEAD request: Storage's response, unread. */
  const unknownError = (status: number, body?: object) =>
    Object.assign(new Error("{}"), {
      name: "StorageUnknownError",
      originalError: new Response(
        body === undefined ? null : JSON.stringify(body),
        { status },
      ),
    });
  const bucket = {
    async upload(
      name: string,
      body: ReadableStream<Uint8Array>,
      options: { upsert?: boolean },
    ) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const stored = nameInUrl(name);
      if (!validName.test(stored)) {
        return {
          data: null,
          error: Object.assign(new Error(invalidKey(stored).message), {
            name: "StorageApiError",
            status: 400,
          }),
        };
      }
      if (objects.has(stored) && !options.upsert) {
        return {
          data: null,
          error: new Error("The resource already exists"),
        };
      }
      objects.set(stored, bytes);
      return {
        data: { path: name, fullPath: `updates/${stored}` },
        error: null,
      };
    },
    async download(name: string) {
      const stored = nameInUrl(name);
      if (!validName.test(stored)) {
        return { data: null, error: unknownError(400, invalidKey(stored)) };
      }
      const bytes = objects.get(stored);
      return bytes === undefined
        ? {
            data: null,
            error: unknownError(400, {
              statusCode: "404",
              error: "not_found",
              message: "Object not found",
            }),
          }
        : { data: new Blob([bytes]), error: null };
    },
    async exists(name: string) {
      if (objects.has(nameInUrl(name))) return { data: true, error: null };
      return { data: false, error: unknownError(400) };
    },
    async remove(names: string[]) {
      const removed = names.filter((name) => objects.delete(name));
      return { data: removed.map((name) => ({ name })), error: null };
    },
    async createSignedUrls(names: string[], expiresIn: number) {
      return {
        data: names.map((name) =>
          objects.has(name)
            ? {
                error: null,
                path: name,
                signedUrl: `https://project.supabase.co/storage/v1/object/sign/updates/${encodeURI(name)}?token=${expiresIn}`,
              }
            : {
                error:
                  "Either the object does not exist or you do not have access to it",
                path: name,
                signedUrl: null,
              },
        ),
        error: null,
      };
    },
  };
  return { bucket, objects };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ storage: { from: () => bucket } }),
}));

setupStorageAdapterTestSuite({
  name: "supabaseStorage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: supabaseStorage({
        basePath: "ota",
        bucketName: "updates",
        supabaseServiceRoleKey: "service-role-key",
        supabaseUrl: "https://project.supabase.co",
      }),
      basePath: "ota",
    };
  },
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
