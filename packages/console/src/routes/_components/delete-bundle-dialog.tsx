import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { createBundleDeleteMutation } from "@/lib/api";
import { CloseButton as AlertDialogCloseButton } from "@kobalte/core/alert-dialog";
import { Trash2 } from "lucide-solid";
import { Show } from "solid-js";

export interface DeleteBundleDialogProps {
  bundleId: string;
  onDeleteSuccess: () => void;
}

export const DeleteBundleDialog = ({
  bundleId,
  onDeleteSuccess,
}: DeleteBundleDialogProps) => {
  const deleteMutation = createBundleDeleteMutation();

  const handleDelete = () => {
    deleteMutation.mutate(bundleId, {
      onSuccess: () => {
        onDeleteSuccess();
      },
      onError: (error) => {
        console.error("Failed to delete bundle:", error);
        showToast({
          title: "Error",
          description: "Failed to delete bundle. Please try again.",
          variant: "error",
        });
      },
    });
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger
        as={Button}
        variant="destructive"
        size="sm"
        class="gap-2 flex-1"
      >
        <Trash2 class="h-4 w-4" />
        Delete Bundle
      </AlertDialogTrigger>
      <AlertDialogOverlay />
      <AlertDialogContent>
        <AlertDialogTitle>Delete Bundle</AlertDialogTitle>
        <AlertDialogDescription>
          Are you sure you want to delete this bundle storage? This action
          cannot be undone.
        </AlertDialogDescription>
        <div class="flex gap-2 justify-end mt-4">
          <AlertDialogCloseButton as={Button} variant="outline" size="sm">
            Cancel
          </AlertDialogCloseButton>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            class="gap-2"
          >
            <Show
              when={deleteMutation.isPending}
              fallback={<Trash2 class="h-4 w-4" />}
            >
              <div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </Show>
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};
