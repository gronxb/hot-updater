import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";

import { fitText } from "@hot-updater/cli-tools";
import type { NativeBuildRow, StorageAdapter } from "@hot-updater/plugin-core";

const protocolOf = (storageUri: string) => {
  try {
    return new URL(storageUri).protocol.replace(":", "");
  } catch {
    return "";
  }
};

const isHttp = (protocol: string) => ["http", "https"].includes(protocol);

/**
 * The artifact's file name, the last path segment of its storage URI without
 * a public URL's query or fragment. It names a file on this machine, so it
 * holds no directory, whatever the URI says.
 */
export const nativeBuildFileName = (build: NativeBuildRow): string => {
  const uriPath = build.artifact_storage_uri.split(/[?#]/u, 1)[0] ?? "";
  const segment = uriPath.split("/").at(-1) ?? "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not percent-encoded: the segment is the name.
  }
  const name = path.basename(decoded.replaceAll("\\", "/"));
  return name === "" || name === "." || name === ".."
    ? `${build.id}.${build.artifact_kind === "app" ? "app.zip" : build.artifact_kind}`
    : name;
};

/**
 * The file a download writes: `output`, in it when it is a directory, or the
 * artifact's name in the current directory.
 */
export const nativeBuildDownloadPath = (
  build: NativeBuildRow,
  output: string | undefined,
): string => {
  if (output === undefined) return path.resolve(nativeBuildFileName(build));
  const resolved = path.resolve(output);
  const isDirectory =
    /[/\\]$/u.test(output) ||
    (fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory() ?? false);
  return isDirectory
    ? path.join(resolved, nativeBuildFileName(build))
    : resolved;
};

/**
 * Where the artifact comes from: the config's storage, by its `get`, so this
 * works on a storage that gives no download URL; or a public URL no storage
 * owns.
 */
const readArtifact = async (
  storage: StorageAdapter,
  build: NativeBuildRow,
): Promise<Response | null> => {
  const storageUri = build.artifact_storage_uri;
  const protocol = protocolOf(storageUri);
  if (protocol === storage.protocol) {
    if (storage.get === undefined) {
      throw new Error(
        `${storage.name} can't read objects, so the CLI can't download through it.\nUse the build's download link on the Console.`,
      );
    }
    return (await storage.get({ storageUri })).response;
  }
  if (isHttp(protocol)) return fetch(storageUri);
  throw new Error(
    `The artifact is in ${protocol || "another"} storage, and this config's storage is ${storage.name}.\nSet storage in hot-updater.config.ts to the one that holds ${storageUri}`,
  );
};

/**
 * Downloads a native build's artifact to `file`, which appears only once all
 * of it arrived: a failed download leaves nothing there.
 */
export const downloadNativeBuild = async (
  storage: StorageAdapter,
  build: NativeBuildRow,
  file: string,
): Promise<{ readonly byteSize: number }> => {
  const response = await readArtifact(storage, build);
  if (response === null || response.status === 404) {
    throw new Error(
      `The artifact isn't in storage: ${build.artifact_storage_uri}\nDelete the build: npx hot-updater native-build delete ${build.id}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw new Error(
      `Storage answered ${response.status} for ${build.artifact_storage_uri}`,
    );
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream),
      fs.createWriteStream(partial),
    );
    const { size } = await fs.promises.stat(partial);
    if (size !== build.byte_size) {
      throw new Error(
        `The download is ${size} bytes, and the build's artifact is ${build.byte_size}.\nRun this again.`,
      );
    }
    await fs.promises.rename(partial, file);
    return { byteSize: size };
  } finally {
    await fs.promises.rm(partial, { force: true });
  }
};

/**
 * The URL a script fetches the artifact from by itself: the storage's
 * download URL, which may expire, or a public artifact's own. Null when there
 * is none, or only one the storage itself can read, such as without a signing
 * credential; stderr says why, so `--json`'s stdout stays one document.
 */
export const resolveNativeBuildDownloadUrl = async (
  storage: StorageAdapter,
  build: NativeBuildRow,
): Promise<string | null> => {
  const storageUri = build.artifact_storage_uri;
  const protocol = protocolOf(storageUri);
  if (protocol !== storage.protocol)
    return isHttp(protocol) ? storageUri : null;
  if (storage.getDownloadUrl === undefined) return null;
  try {
    const { url } = await storage.getDownloadUrl({ storageUri });
    return /^https?:\/\//iu.test(url) ? url : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(fitText(`${storage.name} gave no download URL: ${reason}`));
    return null;
  }
};
