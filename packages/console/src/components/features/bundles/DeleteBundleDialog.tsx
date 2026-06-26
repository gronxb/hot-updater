import type { Bundle } from "@hot-updater/plugin-core";
import { toast } from "sonner";

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
import { useDeleteBundleMutation } from "@/lib/api";

interface DeleteBundleDialogProps {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function DeleteBundleDialog({
  bundle,
  open,
  onOpenChange,
  onSuccess,
}: DeleteBundleDialogProps) {
  const deleteBundleMutation = useDeleteBundleMutation();
  const isDeleting = deleteBundleMutation.isPending;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDeleting) {
      return;
    }

    onOpenChange(nextOpen);
  };

  const handleDelete = async () => {
    if (isDeleting) {
      return;
    }

    try {
      await deleteBundleMutation.mutateAsync({ bundleId: bundle.id });
      toast.success("Bundle deleted successfully");
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      toast.error("Failed to delete bundle");
      console.error(error);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (isDeleting) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the
            bundle and remove it from storage.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="my-4 p-4 bg-muted rounded-lg">
          <p className="text-sm font-medium mb-1">Bundle ID:</p>
          <p className="text-xs font-mono text-muted-foreground break-all">
            {bundle.id}
          </p>
          <p className="text-sm font-medium mt-3 mb-1">Channel:</p>
          <p className="text-xs text-muted-foreground">{bundle.channel}</p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleDelete();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
