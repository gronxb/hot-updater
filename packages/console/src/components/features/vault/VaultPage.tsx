import { LockKeyhole } from "lucide-react";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useVaultKeysQuery,
  useVaultSecretsQuery,
  useVaultStatusQuery,
  useVaultTokensQuery,
} from "@/lib/vault-api";

import { MasterKeysCard } from "./MasterKeysCard";
import { SecretsCard } from "./SecretsCard";
import { TokensCard } from "./TokensCard";

export type VaultTab = "secrets" | "tokens" | "keys";

export const VAULT_TABS: readonly VaultTab[] = ["secrets", "tokens", "keys"];

/**
 * The vault: secrets, write-only, the tokens CI reads them with, and the
 * master keys they are sealed under. Tokens and keys are read only once
 * their tab opens.
 */
export function VaultPage({
  tab,
  onTabChange,
}: {
  readonly tab: VaultTab;
  readonly onTabChange: (tab: VaultTab) => void;
}) {
  const status = useVaultStatusQuery();
  const secrets = useVaultSecretsQuery();
  const tokens = useVaultTokensQuery({ enabled: tab === "tokens" });
  const keys = useVaultKeysQuery({ enabled: tab === "keys" });

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <div className="flex items-center gap-1.5">
          <LockKeyhole
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Vault</h1>
        </div>
        <p className="basis-full pl-12 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          Credentials for CI, encrypted with the console's master key.
        </p>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <div className="mx-auto w-full max-w-5xl">
          <Tabs
            onValueChange={(value) => onTabChange(value as VaultTab)}
            value={tab}
          >
            <TabsList
              aria-label="Vault views"
              className="max-w-full group-data-horizontal/tabs:h-auto"
            >
              <TabsTrigger
                className="min-h-11 flex-none px-3 lg:min-h-7"
                value="secrets"
              >
                Secrets
                {secrets.data === undefined ? null : (
                  <span className="tabular-nums text-muted-foreground">
                    {secrets.data.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger
                className="min-h-11 flex-none px-3 lg:min-h-7"
                value="tokens"
              >
                Tokens
              </TabsTrigger>
              <TabsTrigger
                className="min-h-11 flex-none px-3 lg:min-h-7"
                value="keys"
              >
                Master keys
                {keys.data === undefined || keys.data.remaining === 0 ? null : (
                  <span className="size-1.5 rounded-full bg-warning">
                    <span className="sr-only">Rotation pending</span>
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="secrets">
              <SecretsCard secrets={secrets} status={status} />
            </TabsContent>
            <TabsContent value="tokens">
              <TokensCard secrets={secrets.data ?? []} tokens={tokens} />
            </TabsContent>
            <TabsContent value="keys">
              <MasterKeysCard keys={keys} status={status} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
