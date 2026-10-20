import { createFileRoute } from "@tanstack/react-router";

import { ConsoleFeatureUnavailable } from "@/components/ConsoleFeatureUnavailable";
import {
  VAULT_TABS,
  VaultPage,
  type VaultTab,
} from "@/components/features/vault/VaultPage";
import { requireConsoleFeature } from "@/lib/console-features-api";

interface VaultSearch {
  /** The open view; Secrets when absent. */
  readonly tab?: VaultTab;
}

export const Route = createFileRoute("/vault")({
  beforeLoad: ({ context }) =>
    requireConsoleFeature(context.queryClient, "vault"),
  notFoundComponent: ConsoleFeatureUnavailable,
  component: VaultRoute,
  validateSearch: (search: Record<string, unknown>): VaultSearch =>
    VAULT_TABS.includes(search.tab as VaultTab) && search.tab !== "secrets"
      ? { tab: search.tab as VaultTab }
      : {},
});

function VaultRoute() {
  const { tab = "secrets" } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <VaultPage
      onTabChange={(next) =>
        void navigate({
          search: next === "secrets" ? {} : { tab: next },
          replace: true,
        })
      }
      tab={tab}
    />
  );
}
