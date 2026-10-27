import { createFileRoute } from "@tanstack/react-router";

// A native build's download QR code takes no session and reads nothing:
// see nativeBuildQr.ts.
const handle = async ({ request }: { readonly request: Request }) => {
  const { serveNativeBuildQr } = await import("@/lib/server/nativeBuildQr");
  return serveNativeBuildQr(request);
};

export const Route = createFileRoute("/_hot-updater/native-builds/qr")({
  server: {
    handlers: { ANY: handle },
  },
});
