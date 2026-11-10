import { ArrowUpRight, Copy, RotateCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SchemaMigrationStatus } from "@/lib/schema-migration";

export const DOCTOR_COMMAND = "npx hot-updater doctor";

export const DOCTOR_GUIDE_URL = "https://hot-updater.dev/docs/guides/doctor";

/**
 * What the console shows instead of a page while the schema fence refuses
 * its database: the settings a migration writes, and doctor, which names the
 * command that runs it. Every page reads through the fence, so one notice
 * stands for all.
 */
export function SchemaMigrationRequired({
  status,
  onRetry,
}: {
  readonly status: SchemaMigrationStatus;
  readonly onRetry: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const command = DOCTOR_COMMAND;
  const configFile = (
    <code className="font-mono whitespace-nowrap">hot-updater.config.ts</code>
  );
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Command copied");
    } catch {
      toast.error("Could not copy the command");
    }
  };
  const checkAgain = async () => {
    setChecking(true);
    try {
      await onRetry();
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b bg-background px-3 py-3 sm:min-h-12 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <h1 className="text-sm font-medium">Database migration</h1>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <Empty>
          <EmptyHeader>
            {status.migratable ? (
              <>
                <EmptyTitle>The database needs a migration</EmptyTitle>
                <EmptyDescription>
                  Its schema is older than this console's, so the console stops
                  before reading it. Run this where {configFile} names the
                  database: it names the command that migrates it. Then check
                  again.
                </EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>The database's schema doesn't match</EmptyTitle>
                <EmptyDescription>
                  A newer Hot Updater migrated it, or it uses a layout this
                  console can't migrate, so the console stops before reading it.
                  Run this where {configFile} names the database to see what it
                  needs.
                </EmptyDescription>
              </>
            )}
          </EmptyHeader>
          <EmptyContent>
            <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 overflow-x-auto text-left font-mono text-xs whitespace-nowrap">
                {command}
              </code>
              <Button
                aria-label="Copy command"
                onClick={copyCommand}
                size="icon-sm"
                variant="ghost"
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
            {status.settings.length > 0 ? (
              <ul className="w-full space-y-1 text-left text-xs text-muted-foreground">
                {status.settings.map(({ key, expected, found }) => (
                  <li key={key} className="flex justify-between gap-3">
                    <code className="font-mono">{key}</code>
                    <span className="tabular-nums">
                      {found ?? "missing"} → {expected}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                disabled={checking}
                onClick={checkAgain}
                variant="outline"
              >
                <RotateCw
                  aria-hidden="true"
                  className={checking ? "motion-safe:animate-spin" : undefined}
                  data-icon="inline-start"
                />
                {checking ? "Checking…" : "Check again"}
              </Button>
              <a
                className={buttonVariants({ variant: "ghost" })}
                href={DOCTOR_GUIDE_URL}
                rel="noreferrer"
                target="_blank"
              >
                Doctor guide
                <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
              </a>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    </div>
  );
}
