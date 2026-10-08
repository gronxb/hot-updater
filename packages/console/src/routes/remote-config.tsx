import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFeatureUnavailable } from "@/components/ConsoleFeatureUnavailable";
import {
  REMOTE_CONFIG_TABS,
  RemoteConfigPage,
  type RemoteConfigTab,
} from "@/components/features/remote-config/RemoteConfigPage";
import { requireConsoleFeature } from "@/lib/console-features-api";

interface RemoteConfigSearch {
  /** The open view; Parameters when absent. */
  readonly tab?: RemoteConfigTab;
}

export const Route = createFileRoute("/remote-config")({
  beforeLoad: ({ context }) =>
    requireConsoleFeature(context.queryClient, "remoteConfig"),
  notFoundComponent: ConsoleFeatureUnavailable,
  component: RemoteConfigRoute,
  validateSearch: (search: Record<string, unknown>): RemoteConfigSearch =>
    REMOTE_CONFIG_TABS.includes(search.tab as RemoteConfigTab) &&
    search.tab !== "parameters"
      ? { tab: search.tab as RemoteConfigTab }
      : {},
});

function RemoteConfigRoute() {
  const { tab = "parameters" } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RemoteConfigPage
      onTabChange={(next) =>
        void navigate({
          search: next === "parameters" ? {} : { tab: next },
          replace: true,
        })
      }
      tab={tab}
    />
  );
}
