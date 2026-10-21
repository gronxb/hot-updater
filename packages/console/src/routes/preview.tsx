import { assertCanonicalChannelName } from "@hot-updater/protocol";
import { createFileRoute } from "@tanstack/react-router";

import {
  PreviewPage,
  type PreviewSearch,
} from "@/components/features/preview/PreviewPage";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A channel name a channel link can carry, or undefined. */
const channelName = (value: unknown) => {
  const channel = text(value);
  if (channel === undefined) return undefined;
  try {
    assertCanonicalChannelName(channel);
    return channel;
  } catch {
    return undefined;
  }
};

export const Route = createFileRoute("/preview")({
  component: PreviewRoute,
  validateSearch: (search: Record<string, unknown>): PreviewSearch => {
    const values = {
      build: text(search.build),
      channel: channelName(search.channel),
      before: text(search.before),
      after: text(search.after),
    };
    return Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as PreviewSearch;
  },
});

function PreviewRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PreviewPage
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
      search={search}
    />
  );
}
