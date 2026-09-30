import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

/**
 * A Supabase Storage bucket behind the supabase-js calls the adapter makes,
 * with the results supabase-js returns for missing and existing objects.
 */
const { bucket, objects } = vi.hoisted(() => {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const missing = () => ({
    data: null,
    error: Object.assign(new Error("Object not found"), {
      name: "StorageApiError",
      status: 400,
    }),
  });
  const bucket = {
    async upload(
      key: string,
      body: ReadableStream<Uint8Array>,
      options: { upsert?: boolean },
    ) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (objects.has(key) && !options.upsert) {
        return {
          data: null,
          error: new Error("The resource already exists"),
        };
      }
      objects.set(key, bytes);
      return { data: { path: key, fullPath: `updates/${key}` }, error: null };
    },
    async download(key: string) {
      const bytes = objects.get(key);
      return bytes === undefined
        ? missing()
        : { data: new Blob([bytes]), error: null };
    },
    async exists(key: string) {
      if (objects.has(key)) return { data: true, error: null };
      return {
        data: false,
        error: Object.assign(new Error("{}"), {
          name: "StorageUnknownError",
          originalError: { status: 400 },
        }),
      };
    },
    async remove(keys: string[]) {
      const removed = keys.filter((key) => objects.delete(key));
      return { data: removed.map((name) => ({ name })), error: null };
    },
    async createSignedUrls(keys: string[], expiresIn: number) {
      return {
        data: keys.map((key) => ({
          error: null,
          path: key,
          signedUrl: `https://project.supabase.co/storage/v1/object/sign/updates/${encodeURI(key)}?token=${expiresIn}`,
        })),
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
