import type { Bundle } from "@hot-updater/plugin-core";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  LoaderCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDeleteBundlesMutation } from "@/lib/api";

interface SelectedBundlesDeleteDialogProps {
  readonly bundles: readonly Bundle[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onComplete: (result: DeleteCompletionResult) => void;
}

interface DeleteCompletionResult {
  readonly deletedBundleIds: readonly string[];
  readonly failedBundleIds: readonly string[];
}

type DeletePhase = "confirming" | "deleting" | "complete";
type DeleteItemStatus = "queued" | "deleting" | "deleted" | "failed";

interface DeleteItem {
  readonly bundle: Bundle;
  readonly status: DeleteItemStatus;
  readonly message?: string;
}

const statusLabels = {
  queued: "Queued",
  deleting: "Deleting",
  deleted: "Deleted",
  failed: "Failed",
} as const satisfies Record<DeleteItemStatus, string>;

const getDeleteErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Delete request failed";

const createDeleteItems = (bundles: readonly Bundle[]): DeleteItem[] =>
  bundles.map((bundle) => ({
    bundle,
    status: "queued",
  }));

function getStatusIcon(status: Exclude<DeleteItemStatus, "queued">): {
  readonly className: string;
  readonly Icon: LucideIcon;
} {
  switch (status) {
    case "failed":
      return { className: "size-3.5 text-destructive", Icon: XCircle };
    case "deleting":
      return {
        className: "size-3.5 animate-spin text-primary",
        Icon: LoaderCircle,
      };
    case "deleted":
      return { className: "size-3.5 text-primary", Icon: CheckCircle2 };
  }
}

function DeleteStatusIcon({ status }: { readonly status: DeleteItemStatus }) {
  if (status === "queued") {
    return null;
  }

  const label = statusLabels[status];
  const { className, Icon } = getStatusIcon(status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label}>
          <Icon className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SelectedBundlesDeleteDialog({
  bundles,
  open,
  onOpenChange,
  onComplete,
}: SelectedBundlesDeleteDialogProps) {
  const deleteBundlesMutation = useDeleteBundlesMutation();
  const [phase, setPhase] = useState<DeletePhase>("confirming");
  const [items, setItems] = useState<DeleteItem[]>(() =>
    createDeleteItems(bundles),
  );
  const isDeleting = phase === "deleting";
  const totalCount = items.length;
  const deletedCount = items.filter((item) => item.status === "deleted").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const activeCount = deletedCount + failedCount;
  const failedBundleIds = items
    .filter((item) => item.status === "failed")
    .map((item) => item.bundle.id);
  const hasFailures = failedBundleIds.length > 0;
  const title =
    phase === "confirming" ? "Delete selected bundles?" : "Deleting bundles";
  const description =
    phase === "confirming"
      ? `This permanently deletes ${bundles.length} artifacts and their stored files. Artifacts referenced by a Release fail safely; shared assets are reclaimed by storage prune.`
      : phase === "deleting"
        ? `Deleting ${totalCount} bundles in one batch.`
        : `${activeCount} of ${totalCount} delete requests finished.`;
  const deleteButtonLabel = isDeleting ? "Deleting..." : "Delete";

  useEffect(() => {
    if (open && phase === "confirming") {
      setItems(createDeleteItems(bundles));
    }
  }, [bundles, open, phase]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDeleting) {
      return;
    }

    onOpenChange(nextOpen);

    if (!nextOpen) {
      setPhase("confirming");
      setItems(createDeleteItems(bundles));
    }
  };

  const runDeletion = async (bundleIds: readonly string[]) => {
    if (isDeleting || bundleIds.length === 0) {
      return;
    }

    const bundleIdSet = new Set(bundleIds);

    setPhase("deleting");
    setItems((currentItems) =>
      currentItems.map((item) =>
        bundleIdSet.has(item.bundle.id)
          ? { bundle: item.bundle, status: "deleting" }
          : item,
      ),
    );

    try {
      const result = await deleteBundlesMutation.mutateAsync({
        bundleIds: [...bundleIds],
      });
      setItems((currentItems) =>
        currentItems.map((item) =>
          bundleIdSet.has(item.bundle.id)
            ? { bundle: item.bundle, status: "deleted" }
            : item,
        ),
      );
      setPhase("complete");
      onComplete({ deletedBundleIds: bundleIds, failedBundleIds: [] });
      toast.success(
        result.missingBundleIds.length > 0
          ? `${result.deletedBundleIds.length} deleted, ${result.missingBundleIds.length} already absent`
          : `${bundleIds.length} bundles deleted successfully`,
      );
    } catch (error) {
      setItems((currentItems) =>
        currentItems.map((item) =>
          bundleIdSet.has(item.bundle.id)
            ? {
                bundle: item.bundle,
                message: getDeleteErrorMessage(error),
                status: "failed",
              }
            : item,
        ),
      );
      setPhase("complete");
      onComplete({ deletedBundleIds: [], failedBundleIds: bundleIds });
      toast.error(`0 deleted, ${bundleIds.length} failed`);
    }
  };

  const handleDelete = () => {
    void runDeletion(items.map((item) => item.bundle.id));
  };

  const handleRetryFailed = () => {
    void runDeletion(failedBundleIds);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isDeleting}
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (isDeleting) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isDeleting) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {phase === "confirming" ? null : (
          <Card>
            <CardContent className="max-h-[50vh] overflow-y-auto p-0">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-12 text-center">Status</TableHead>
                    <TableHead>Bundle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.bundle.id}>
                      <TableCell className="text-center align-middle">
                        <div className="flex justify-center">
                          <DeleteStatusIcon status={item.status} />
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="min-w-0">
                          <div className="break-all font-mono text-[11px] text-foreground">
                            {item.bundle.id}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{item.bundle.platform}</span>
                            {item.message ? (
                              <span className="text-destructive">
                                {item.message}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <DialogFooter>
          {phase === "confirming" ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={totalCount === 0}
              >
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            </>
          ) : null}
          {phase === "deleting" ? (
            <Button variant="destructive" disabled>
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
              {deleteButtonLabel}
            </Button>
          ) : null}
          {phase === "complete" ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              {hasFailures ? (
                <Button onClick={handleRetryFailed}>
                  <RotateCcw data-icon="inline-start" />
                  Retry failed
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
