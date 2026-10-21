import { createFileRoute } from "@tanstack/react-router";

// A channel link's QR code takes no session: see channelLinkQr.ts.
const handle = async ({ request }: { readonly request: Request }) => {
  const [{ loadConsole }, { serveChannelLinkQr }] = await Promise.all([
    import("@/lib/server/config.server"),
    import("@/lib/server/channelLinkQr"),
  ]);
  return serveChannelLinkQr(
    request,
    async (request) => (await loadConsole(request)).config.channelLinkPrefix,
  );
};

export const Route = createFileRoute("/_hot-updater/preview/channel-qr")({
  server: {
    handlers: { ANY: handle },
  },
});
