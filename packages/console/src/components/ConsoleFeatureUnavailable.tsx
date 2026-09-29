import { ArrowUpRight } from "lucide-react";

import { NotFoundPage } from "@/components/NotFoundPage";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  type ConsolePlugin,
  consoleFeatures,
  unavailableReason,
} from "@/lib/console-features";
import {
  notFoundFeature,
  useConsoleFeatures,
} from "@/lib/console-features-api";

export const CONSOLE_DEPLOYMENT_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/console-deployment";

const pluginLabels: Readonly<Record<ConsolePlugin, string>> = {
  insights: "Insights",
  apiKeys: "API keys",
};

/**
 * A feature route's not-found state: the plugin to add, or, for a feature a
 * self-hosted server does not serve, the database config it needs.
 */
export function ConsoleFeatureUnavailable({
  data,
}: {
  readonly data?: unknown;
}) {
  const feature = notFoundFeature(data);
  const remote = useConsoleFeatures().data?.remote === true;
  if (feature === undefined) return <NotFoundPage />;

  const { plugin } = consoleFeatures[feature];
  const label = pluginLabels[plugin];
  const pluginCall = <code className="font-mono">{`${plugin}()`}</code>;
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b bg-background px-3 py-3 sm:min-h-12 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <h1 className="text-sm font-medium">{label}</h1>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <Empty>
          <EmptyHeader>
            {unavailableReason(feature, { remote }) === "remote" ? (
              <>
                <EmptyTitle>Needs the server's database</EmptyTitle>
                <EmptyDescription>
                  This console reaches a self-hosted server through its admin
                  API, which serves Insights events and installations only.
                  Configure the console with the database the server uses.
                </EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>{label} not installed</EmptyTitle>
                <EmptyDescription>
                  Add {pluginCall} to <code className="font-mono">plugins</code>{" "}
                  {remote
                    ? "where you create the server."
                    : "where you create the server and in the console config."}
                </EmptyDescription>
              </>
            )}
          </EmptyHeader>
          <EmptyContent>
            <a
              className={buttonVariants({ variant: "outline" })}
              href={CONSOLE_DEPLOYMENT_GUIDE_URL}
              rel="noreferrer"
              target="_blank"
            >
              Console setup guide
              <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
            </a>
          </EmptyContent>
        </Empty>
      </div>
    </div>
  );
}
