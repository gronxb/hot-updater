import type { NativeBuildRow } from "@hot-updater/plugin-core";
import type { NativeArtifactProblem } from "@hot-updater/protocol/native-artifact";

import { NATIVE_BUILD_IMPORT_PATH } from "./native-builds";

/** What the import route answered. */
export type NativeBuildUploadResult =
  | { readonly ok: true; readonly nativeBuild: NativeBuildRow }
  | { readonly ok: false; readonly problems: readonly NativeArtifactProblem[] };

/**
 * Uploads a store artifact to the import route, reporting the bytes sent:
 * an XMLHttpRequest, since `fetch` reports no upload progress. The route
 * reads the artifact again, stores it and its built-in bundle, and registers
 * the build, after the last byte.
 */
export const uploadNativeBuild = (
  file: File,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<NativeBuildUploadResult> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `${NATIVE_BUILD_IMPORT_PATH}?name=${encodeURIComponent(file.name)}`,
    );
    request.setRequestHeader("content-type", "application/octet-stream");
    request.responseType = "text";
    request.upload.onprogress = (event) => {
      onProgress(
        event.loaded,
        event.lengthComputable ? event.total : file.size,
      );
    };
    request.onerror = () =>
      reject(new Error("The upload failed: the Console could not be reached."));
    request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    request.onload = () => {
      let body: {
        nativeBuild?: NativeBuildRow;
        problems?: NativeArtifactProblem[];
      } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        // A proxy's or a sign-in's answer, not the route's.
      }
      if (request.status === 201 && body.nativeBuild) {
        resolve({ ok: true, nativeBuild: body.nativeBuild });
        return;
      }
      resolve({
        ok: false,
        problems: body.problems ?? [
          {
            code: "UNREADABLE",
            message:
              request.status === 401 || request.status === 403
                ? "Your Console session ended. Sign in again, then import the build."
                : `The Console answered ${request.status} ${request.statusText}.`,
          },
        ],
      });
    };
    signal?.addEventListener("abort", () => request.abort());
    request.send(file);
  });
