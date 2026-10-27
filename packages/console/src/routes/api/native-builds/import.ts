import { createFileRoute } from "@tanstack/react-router";

/**
 * Whether a request comes from the console's own pages: server functions
 * get this check from TanStack Start's CSRF middleware, which skips routes.
 */
const isSameOrigin = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });

/**
 * Imports a store artifact (`.ipa`, `.aab`, `.apk`) the request's body
 * carries, named by `?name=`: the Native Builds tab's drop zone posts the
 * file here, and gets the registered build, or why it can't be imported.
 */
export const Route = createFileRoute("/api/native-builds/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return new Response("Forbidden", { status: 403 });
        }
        const { prepareConfig } = await import("@/lib/server/config.server");
        const {
          importNativeBuild,
          NATIVE_BUILD_IMPORT_MAX_BYTES,
          NativeBuildImportRefusal,
        } = await import("@/lib/server/nativeBuildImport");
        let deps: Awaited<ReturnType<typeof prepareConfig>>;
        try {
          deps = await prepareConfig(request);
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
        const fileName = new URL(request.url).searchParams.get("name") ?? "";
        const length = Number(request.headers.get("content-length"));
        if (request.body === null || !Number.isFinite(length) || length <= 0) {
          return json(411, {
            problems: [
              {
                code: "UNREADABLE",
                message: "The upload carries no file.",
              },
            ],
          });
        }
        if (length > NATIVE_BUILD_IMPORT_MAX_BYTES) {
          return json(413, {
            problems: [
              {
                code: "UNREADABLE",
                message: `The file is larger than the Console takes (${NATIVE_BUILD_IMPORT_MAX_BYTES} bytes). Import it with \`hot-updater native-build import\`.`,
              },
            ],
          });
        }
        try {
          const nativeBuild = await importNativeBuild({
            body: request.body,
            fileName,
            core: deps.core,
            storage: deps.storage,
            updateStrategy: deps.config.updateStrategy,
          });
          return json(201, { nativeBuild });
        } catch (error) {
          if (error instanceof NativeBuildImportRefusal) {
            return json(error.status, { problems: error.problems });
          }
          console.error("Native build import failed:", error);
          return json(500, {
            problems: [
              {
                code: "UNREADABLE",
                message: `The build could not be stored or registered: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          });
        }
      },
    },
  },
});
