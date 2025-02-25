import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import { initializeApp } from "firebase/app";
import {
  type StorageReference,
  deleteObject,
  getDownloadURL,
  getStorage,
  listAll,
  ref,
  uploadBytes,
} from "firebase/storage";
import fs from "fs/promises";
import mime from "mime";

export interface FirebaseStorageConfig {
  apiKey: string;
  projectId: string;
  storageBucket: string;
}

export const firebaseStorage =
  (config: FirebaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const app = initializeApp(config);
    const storage = getStorage(app);

    return {
      name: "firebaseStorage",
      async deleteBundle(bundleId) {
        const Key = [bundleId].join("/");
        const listRef = ref(storage, bundleId);
        try {
          const listResult = await listAll(listRef);
          await Promise.all(
            listResult.items.map((itemRef: StorageReference) =>
              deleteObject(itemRef),
            ),
          );
        } catch (e) {
          console.error("Error listing or deleting files:", e);
          throw e;
        }
        return Key;
      },
      async uploadBundle(bundleId, bundlePath) {
        const Body = await fs.readFile(bundlePath);
        const ContentType =
          mime.getType(bundlePath) ?? "application/octet-stream";
        const filename = path.basename(bundlePath);

        const Key = [bundleId, filename].join("/");
        const fileRef = ref(storage, Key);

        await uploadBytes(fileRef, new Uint8Array(Body), {
          contentType: ContentType,
        });

        hooks?.onStorageUploaded?.();

        const fileUrl = await getDownloadURL(fileRef);

        return {
          fileUrl: hooks?.transformFileUrl?.(Key) ?? fileUrl,
        };
      },
    };
  };
