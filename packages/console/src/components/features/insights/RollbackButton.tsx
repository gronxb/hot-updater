import { useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import {
  usePreflightReleaseMutation,
  useUpdateReleaseMutation,
} from "@/lib/api";
import type { AdoptionRelease } from "@/lib/release-adoption";

import { bundleName } from "./ComparedBundlesChart";

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/**
 * Rolls a crashing bundle back the way its editor does: disabling its
 * release sends installations running it back to the previous enabled
 * release on their next update check.
 */
export function RollbackButton({
  release,
  rate,
  crashes,
  attempts,
}: {
  readonly release: AdoptionRelease;
  readonly rate: number;
  readonly crashes: number;
  readonly attempts: number;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const preflight = usePreflightReleaseMutation();
  const update = useUpdateReleaseMutation();
  const busy = preflight.isPending || update.isPending;
  const name = bundleName(release);
  const rollBack = async () => {
    const input = {
      expectedRevision: release.revision,
      patch: { enabled: false },
      releaseId: release.releaseId,
    };
    setError("");
    try {
      await preflight.mutateAsync(input);
      await update.mutateAsync(input);
      await queryClient.invalidateQueries({
        queryKey: ["insights", "adoption-releases"],
      });
      toast.success(`${name} rolled back`, {
        description:
          "Installations running it return to the previous enabled bundle on their next update check.",
      });
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The bundle could not be rolled back.",
      );
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) setError("");
      }}
    >
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Undo2 aria-hidden="true" data-icon="inline-start" />
        Roll back
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Roll back {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It crashed for {percent(rate)} of the installations that tried it (
            {crashes.toLocaleString()} of {attempts.toLocaleString()}). Rolling
            back disables it, so installations running it return to the previous
            enabled bundle on their next update check. You can enable it again
            in its bundle details.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={() => void rollBack()}
          >
            {busy ? "Rolling back…" : "Roll back"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
