import { createFileRoute } from "@tanstack/react-router";

import { ConsoleBundlesPage } from "@/components/ConsoleBundlesPage";

export const Route = createFileRoute("/")({
  component: BundlesPage,
  validateSearch: (search: Record<string, unknown>) => {
    const parsedPage =
      typeof search.page === "number"
        ? search.page
        : typeof search.page === "string"
          ? Number(search.page)
          : undefined;

    return {
      channel: search.channel as string | undefined,
      platform: search.platform as "ios" | "android" | undefined,
      page:
        parsedPage !== undefined &&
        Number.isInteger(parsedPage) &&
        parsedPage > 1
          ? parsedPage
          : undefined,
      after: search.after as string | undefined,
      before: search.before as string | undefined,
      bundleId: search.bundleId as string | undefined,
      expandedBundleId: search.expandedBundleId as string | undefined,
    };
  },
});

function BundlesPage() {
  return <ConsoleBundlesPage />;
}
