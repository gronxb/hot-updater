import dayjs from "dayjs";
import {
  AlertTriangle,
  Clipboard,
  Eye,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useRemoteConfigVersionQuery,
  useRemoteConfigVersionsQuery,
  useRollbackRemoteConfigMutation,
} from "@/lib/remote-config-api";

/** A publish time: the date and time, with the exact UTC time on hover. */
function PublishedAt({ ms }: { readonly ms: number }) {
  const date = new Date(ms);
  return (
    <time
      className="tabular-nums"
      dateTime={date.toISOString()}
      title={`${date.toISOString().replace("T", " ").slice(0, 19)} UTC`}
    >
      {dayjs(ms).format("YYYY/MM/DD HH:mm")}
    </time>
  );
}

function VersionDialog({
  version,
  onOpenChange,
}: {
  readonly version: number | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const detail = useRemoteConfigVersionQuery(version);
  const json =
    detail.data === null || detail.data === undefined
      ? null
      : JSON.stringify(detail.data.template, null, 2);
  return (
    <Dialog onOpenChange={onOpenChange} open={version !== null}>
      <DialogContent className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version {version}</DialogTitle>
          <DialogDescription>
            The template as it was published, in the JSON the admin API takes.
          </DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : json === null ? (
          <p className="text-sm text-muted-foreground">
            This version could not be read.
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <pre className="min-h-0 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {json}
            </pre>
            <Button
              className="self-end"
              onClick={() => {
                navigator.clipboard.writeText(json).then(
                  () => toast.success("Template JSON copied"),
                  () => toast.error("Unable to copy the template"),
                );
              }}
              size="sm"
              variant="outline"
            >
              <Clipboard data-icon="inline-start" />
              Copy JSON
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Published versions, newest first, each viewable and restorable. */
export function VersionsCard({
  activeVersion,
  hasDraft,
  onRolledBack,
  onStartEditing,
}: {
  readonly activeVersion: number;
  /** Unpublished edits exist; a rollback discards them. */
  readonly hasDraft: boolean;
  readonly onRolledBack: () => void;
  readonly onStartEditing: () => void;
}) {
  const versions = useRemoteConfigVersionsQuery({ enabled: true });
  const rollback = useRollbackRemoteConfigMutation();
  const [viewing, setViewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const rows = versions.data?.pages.flatMap((page) => page.versions) ?? [];

  const restore = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (restoring === null) return;
    try {
      const result = await rollback.mutateAsync({
        version: restoring,
        baseVersion: activeVersion,
      });
      if (result.status === "published") {
        toast.success(
          `Version ${result.version.version} restores version ${restoring}`,
        );
        onRolledBack();
      } else if (result.status === "conflict") {
        toast.error(
          `Version ${result.currentVersion} was published meanwhile. Review it, then roll back again.`,
        );
      } else {
        toast.error("That version no longer exists.");
      }
      setRestoring(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to roll back",
      );
    }
  };

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3 sm:px-6">
        <CardTitle className="text-sm">
          <h2>Versions</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {versions.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Versions couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check the connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void versions.refetch()}
                  size="xs"
                  variant="outline"
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : versions.isLoading ? (
          <div className="flex flex-col gap-3 p-4 sm:p-6">
            <span className="sr-only">Loading versions</span>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton className="h-10 w-full" key={index} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>No versions yet</EmptyTitle>
              <EmptyDescription>
                Your first publish becomes version 1. Every publish after it is
                kept here, ready to roll back to.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button className="min-h-11 sm:min-h-7" onClick={onStartEditing}>
                Add a parameter
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <ol aria-label="Versions" className="divide-y">
              {rows.map((row) => (
                <li
                  className="grid gap-2 px-4 py-3 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                  key={row.version}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium tabular-nums">
                        Version {row.version}
                      </span>
                      {row.version === activeVersion ? (
                        <Badge>Active</Badge>
                      ) : null}
                      {row.updateType === "ROLLBACK" ? (
                        <Badge variant="outline">
                          Rollback to v{row.rollbackSource}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <PublishedAt ms={row.createdAtMs} />
                      {row.description === null ? null : (
                        <> · {row.description}</>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-1 md:justify-end">
                    <Button
                      className="min-h-11 md:min-h-7"
                      onClick={() => setViewing(row.version)}
                      size="sm"
                      variant="ghost"
                    >
                      <Eye data-icon="inline-start" />
                      View
                    </Button>
                    <Button
                      className="min-h-11 md:min-h-7"
                      disabled={row.version === activeVersion}
                      onClick={() => setRestoring(row.version)}
                      size="sm"
                      variant="outline"
                    >
                      <RotateCcw data-icon="inline-start" />
                      Roll back
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            {versions.hasNextPage ? (
              <div className="border-t px-4 py-3 sm:px-6">
                <Button
                  className="min-h-11 w-full sm:min-h-7 sm:w-auto"
                  disabled={versions.isFetchingNextPage}
                  onClick={() => void versions.fetchNextPage()}
                  variant="outline"
                >
                  {versions.isFetchingNextPage ? (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : null}
                  Load older versions
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      <VersionDialog
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        version={viewing}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!rollback.isPending && !open) setRestoring(null);
        }}
        open={restoring !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Roll back to version {restoring}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Version {activeVersion + 1} will publish a copy of version{" "}
              {restoring}, and devices get its values on their next fetch.
              {hasDraft ? " Your unpublished changes are discarded." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollback.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={rollback.isPending}
              onClick={(event: MouseEvent<HTMLButtonElement>) =>
                void restore(event)
              }
            >
              {rollback.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <RotateCcw data-icon="inline-start" />
              )}
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
