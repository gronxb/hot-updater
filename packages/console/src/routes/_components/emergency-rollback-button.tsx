import { CloseButton as AlertDialogCloseButton } from "@kobalte/core/alert-dialog";
import { useQueryClient } from "@tanstack/solid-query";
import { AlertTriangle } from "lucide-solid";
import { createSignal, Show } from "solid-js";
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
import { api } from "@/lib/api";

export interface EmergencyRollbackButtonProps {
  bundleId: string;
}

export const EmergencyRollbackButton = ({
  bundleId,
}: EmergencyRollbackButtonProps) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const handleRollback = async () => {
    setIsSubmitting(true);
    try {
      const res = await api.bundles[":bundleId"].$patch({
        param: { bundleId },
        json: {
          enabled: false,
          rolloutPercentage: 0,
        },
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error: string;
        } | null;
        throw new Error(
          json?.error ?? `Failed to stop rollout (HTTP ${res.status})`,
        );
      }

      showToast({
        title: "Rollout stopped",
        description: "Bundle has been disabled and rollout stopped.",
        variant: "success",
      });

      queryClient.invalidateQueries({ queryKey: ["bundle", bundleId] });
      queryClient.invalidateQueries({ queryKey: ["bundles"] });
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      setTimeout(() => setOpen(false), 100);
    } catch (error) {
      console.error("Emergency rollback error:", error);
      showToast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to stop rollout",
        variant: "error",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open()} onOpenChange={setOpen}>
      <AlertDialogTrigger
        as={Button}
        variant="destructive"
        size="sm"
        class="gap-2 w-full"
      >
        <AlertTriangle class="h-4 w-4" />
        Emergency Rollback
      </AlertDialogTrigger>
      <AlertDialogOverlay />
      <AlertDialogContent>
        <AlertDialogTitle>Emergency Rollback</AlertDialogTitle>
        <AlertDialogDescription>
          This will immediately disable this bundle and stop the rollout.
        </AlertDialogDescription>
        <div class="flex gap-2 justify-end mt-4">
          <AlertDialogCloseButton as={Button} variant="outline" size="sm">
            Cancel
          </AlertDialogCloseButton>
          <Button
            variant="destructive"
            size="sm"
            class="gap-2"
            onClick={handleRollback}
            disabled={isSubmitting()}
          >
            <Show
              when={isSubmitting()}
              fallback={<AlertTriangle class="h-4 w-4" />}
            >
              <div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </Show>
            {isSubmitting() ? "Stopping..." : "Stop Rollout"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};
