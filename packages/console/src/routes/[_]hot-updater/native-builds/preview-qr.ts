import { createFileRoute } from "@tanstack/react-router";

// A sandbox preview link's QR code takes no session and reads nothing: see
// nativeBuildQr.ts.
const handle = async ({ request }: { readonly request: Request }) => {
  const { serveSandboxPreviewQr } = await import("@/lib/server/nativeBuildQr");
  return serveSandboxPreviewQr(request);
};

export const Route = createFileRoute("/_hot-updater/native-builds/preview-qr")({
  server: {
    handlers: { ANY: handle },
  },
});
