import { Loader2, Trash2 } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";

import { shortenIdentifier } from "@/components/HashValueDisplay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useDeleteInsightsDataMutation } from "@/lib/insights-api";
import {
  DEFAULT_INSIGHTS_RETENTION,
  formatDays,
  type InsightsRetentionDays,
} from "@/lib/insights-retention";

const counted = (count: number, noun: string) =>
  `${count.toLocaleString("en")} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Deletes an installation's Insights data, or that of every installation
 * whose latest report names its user, once confirmed.
 */
export function DeleteInsightsDataDialog({
  installId,
  userId,
  onDeleted,
  retention = DEFAULT_INSIGHTS_RETENTION,
}: {
  readonly installId: string;
  /** The user the installation's latest report names, if any. */
  readonly userId: string | null;
  readonly onDeleted?: () => void;
  readonly retention?: InsightsRetentionDays;
}) {
  const [open, setOpen] = useState(false);
  const [wholeUser, setWholeUser] = useState(false);
  const deletion = useDeleteInsightsDataMutation();
  const user = wholeUser ? userId : null;

  const handleDelete = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      const deleted = await deletion.mutateAsync(
        user === null ? { installId } : { userId: user },
      );
      setOpen(false);
      toast.success(
        `Deleted ${counted(deleted.events, "event")} and ${counted(deleted.installations, "latest report")}`,
      );
      onDeleted?.();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to delete Insights data",
      );
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (deletion.isPending) return;
        setOpen(nextOpen);
        if (!nextOpen) setWholeUser(false);
      }}
    >
      <AlertDialogTrigger
        render={<Button className="h-11 lg:h-8" size="lg" variant="outline" />}
      >
        <Trash2 aria-hidden="true" data-icon="inline-start" />
        Delete data
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {user === null
              ? "Delete this installation's Insights data?"
              : `Delete the Insights data of user ${user}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {user === null
              ? `Deletes the events and latest report of installation ${shortenIdentifier(installId)}.`
              : "Deletes the events and latest report of every installation whose latest report names this user."}{" "}
            Counts and unique-installation estimates hold no identifiers, so
            they stay; estimates age out within{" "}
            {formatDays(retention.dailyDays)}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {userId === null ? null : (
          <Field orientation="horizontal">
            <Switch
              checked={wholeUser}
              disabled={deletion.isPending}
              id="delete-insights-whole-user"
              onCheckedChange={setWholeUser}
            />
            <FieldLabel htmlFor="delete-insights-whole-user">
              Every installation of this user
            </FieldLabel>
          </Field>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={deletion.isPending}
            onClick={(event) => void handleDelete(event)}
            variant="destructive"
          >
            {deletion.isPending ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            Delete data
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
