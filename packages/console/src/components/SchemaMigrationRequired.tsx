import { ArrowUpRight, RotateCw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SchemaMigrationRequiredError } from "@/lib/schema-migration";

export const DOCTOR_FIX_COMMAND = "npx hot-updater doctor --fix";

export const DOCTOR_GUIDE_URL = "https://hot-updater.dev/docs/guides/doctor";

/**
 * What the console shows instead of a page while the schema fence refuses
 * its database: the settings a migration writes, and the command that runs
 * it. Every page reads through the fence, so one notice stands for all.
 */
export function SchemaMigrationRequired({
  error,
  onRetry,
}: {
  readonly error: SchemaMigrationRequiredError;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b bg-background px-3 py-3 sm:min-h-12 sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1" />
        <h1 className="text-sm font-medium">Database migration</h1>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>The database needs a migration</EmptyTitle>
            <EmptyDescription>
              Its schema is older than this console's, so the console stops
              before reading it. Run this where{" "}
              <code className="font-mono">hot-updater.config.ts</code> names the
              database, then check again.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <pre className="w-full overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 text-left font-mono text-xs">
              {DOCTOR_FIX_COMMAND}
            </pre>
            {error.settings.length > 0 ? (
              <ul className="w-full space-y-1 text-left text-xs text-muted-foreground">
                {error.settings.map(({ key, expected, found }) => (
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
              <Button onClick={onRetry} variant="outline">
                <RotateCw aria-hidden="true" data-icon="inline-start" />
                Check again
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
