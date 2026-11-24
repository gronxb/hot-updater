import { useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ReleaseIdDisplay } from "@/components/ReleaseIdDisplay";
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
  onRolledBack,
  showPlatform = false,
}: {
  readonly release: AdoptionRelease;
  readonly rate: number;
  readonly crashes: number;
  readonly attempts: number;
  /** Runs once the release is disabled, before the bundle list reloads. */
  readonly onRolledBack?: () => void;
  /** Whether the report mixes platforms, so the label needs its platform. */
  readonly showPlatform?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The dialog names the release with a copy button; first focus goes to
  // Cancel instead, so a keyboard opens no tooltip and Enter rolls nothing back.
  const cancel = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const preflight = usePreflightReleaseMutation();
  const update = useUpdateReleaseMutation();
  const busy = preflight.isPending || update.isPending;
  const id = release.releaseId;
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
      onRolledBack?.();
      await queryClient.invalidateQueries({
        queryKey: ["insights", "adoption-releases"],
      });
      toast.success(`${id} rolled back`, {
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
      <AlertDialogContent initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>Roll back this bundle?</AlertDialogTitle>
          <ReleaseIdDisplay
            releaseId={id}
            label={release.label}
            platform={showPlatform ? release.platform : undefined}
          />
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
          <AlertDialogCancel ref={cancel} disabled={busy}>
            Cancel
          </AlertDialogCancel>
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
