import type { Bundle } from "@hot-updater/plugin-core";
import { LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type DeleteItem,
  SelectedBundlesDeleteProgressTable,
} from "@/components/features/bundles/SelectedBundlesDeleteProgressTable";
import { useDeleteBundleMutation } from "@/lib/api";

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
const getDeleteErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Delete request failed";

const createDeleteItems = (bundles: readonly Bundle[]): DeleteItem[] =>
  bundles.map((bundle) => ({
    bundle,
    status: "queued",
  }));

export function SelectedBundlesDeleteDialog({
  bundles,
  open,
  onOpenChange,
  onComplete,
}: SelectedBundlesDeleteDialogProps) {
  const deleteBundleMutation = useDeleteBundleMutation();
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
      ? `This action cannot be undone. This will permanently delete ${bundles.length} bundles and remove them from storage.`
      : `${activeCount} of ${totalCount} delete requests finished.`;
  const deleteButtonLabel = useMemo(() => {
    if (!isDeleting) {
      return "Delete";
    }

    const progressIndex = Math.min(activeCount + 1, totalCount);

    return `Deleting ${progressIndex}/${totalCount}`;
  }, [activeCount, isDeleting, totalCount]);

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
    const deletedBundleIds: string[] = [];
    const nextFailedBundleIds: string[] = [];

    setPhase("deleting");
    setItems((currentItems) =>
      currentItems.map((item) =>
        bundleIdSet.has(item.bundle.id)
          ? { bundle: item.bundle, status: "queued" }
          : item,
      ),
    );

    for (const bundleId of bundleIds) {
      setItems((currentItems) =>
        currentItems.map((item) =>
          item.bundle.id === bundleId
            ? { bundle: item.bundle, status: "deleting" }
            : item,
        ),
      );

      try {
        await deleteBundleMutation.mutateAsync({ bundleId });
        deletedBundleIds.push(bundleId);
        setItems((currentItems) =>
          currentItems.map((item) =>
            item.bundle.id === bundleId
              ? { bundle: item.bundle, status: "deleted" }
              : item,
          ),
        );
      } catch (error) {
        nextFailedBundleIds.push(bundleId);
        setItems((currentItems) =>
          currentItems.map((item) =>
            item.bundle.id === bundleId
              ? {
                  bundle: item.bundle,
                  message: getDeleteErrorMessage(error),
                  status: "failed",
                }
              : item,
          ),
        );
      }
    }

    setPhase("complete");
    onComplete({ deletedBundleIds, failedBundleIds: nextFailedBundleIds });

    if (nextFailedBundleIds.length > 0) {
      toast.error(
        `${deletedBundleIds.length} deleted, ${nextFailedBundleIds.length} failed`,
      );
      return;
    }

    toast.success(`${deletedBundleIds.length} bundles deleted successfully`);
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
          <SelectedBundlesDeleteProgressTable items={items} />
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
