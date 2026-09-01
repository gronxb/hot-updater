import { createUUIDv7, type ChannelRow } from "@hot-updater/plugin-core";
import { Loader2, Plus, Tag, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  useChannelsQuery,
  useCreateChannelMutation,
  useDeleteChannelMutation,
} from "@/lib/api";

interface ChannelManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelManagementDialog({
  open,
  onOpenChange,
}: ChannelManagementDialogProps) {
  const [channelName, setChannelName] = useState("");
  const [channelToDelete, setChannelToDelete] = useState<ChannelRow | null>(
    null,
  );
  const { data: channels = [], isPending: isLoadingChannels } =
    useChannelsQuery();
  const createChannel = useCreateChannelMutation();
  const deleteChannel = useDeleteChannelMutation();
  const normalizedName = channelName.trim();

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName || createChannel.isPending) {
      return;
    }

    try {
      const result = await createChannel.mutateAsync({
        row: { id: createUUIDv7(), name: normalizedName },
        onConflict: "returnExisting",
      });
      setChannelName("");
      if (result.inserted) {
        toast.success(`Channel ${result.row.name} created`);
      } else {
        toast.info(`Channel ${result.row.name} already exists`);
      }
    } catch (error) {
      toast.error("Failed to create channel");
      console.error(error);
    }
  };

  const handleDelete = async () => {
    if (!channelToDelete || deleteChannel.isPending) {
      return;
    }

    try {
      const result = await deleteChannel.mutateAsync({
        id: channelToDelete.id,
      });

      if (result.deleted) {
        toast.success(`Channel ${channelToDelete.name} deleted`);
      } else if (result.reason === "not_empty") {
        toast.error(
          `Channel ${channelToDelete.name} is still in use and cannot be deleted`,
        );
      } else {
        toast.error(`Channel ${channelToDelete.name} no longer exists`);
      }
      setChannelToDelete(null);
    } catch (error) {
      toast.error("Failed to delete channel");
      console.error(error);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="size-4 text-muted-foreground" />
              Channels
            </DialogTitle>
            <DialogDescription>
              Create deployment channels and remove them when no bundle uses
              them. Empty channels remain available until you delete them.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate}>
            <FieldGroup className="gap-2">
              <Field orientation="horizontal">
                <FieldLabel htmlFor="channel-name" className="sr-only">
                  Channel name
                </FieldLabel>
                <Input
                  id="channel-name"
                  value={channelName}
                  onChange={(event) => setChannelName(event.target.value)}
                  placeholder="Channel name"
                  autoComplete="off"
                  disabled={createChannel.isPending}
                />
                <Button
                  type="submit"
                  disabled={!normalizedName || createChannel.isPending}
                >
                  {createChannel.isPending ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <Plus data-icon="inline-start" />
                  )}
                  Create
                </Button>
              </Field>
            </FieldGroup>
          </form>

          <div className="max-h-72 overflow-y-auto rounded-lg border">
            {isLoadingChannels ? (
              <div className="flex h-20 items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-3.5 animate-spin" />
                Loading channels
              </div>
            ) : channels.length === 0 ? (
              <div className="flex h-20 items-center justify-center text-muted-foreground">
                No channels yet
              </div>
            ) : (
              <ul className="divide-y">
                {channels.map((channel) => (
                  <li
                    key={channel.id}
                    className="flex min-h-12 items-center gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {channel.name}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {channel.id}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${channel.name}`}
                      title={`Delete ${channel.name}`}
                      disabled={deleteChannel.isPending}
                      onClick={() => setChannelToDelete(channel)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 data-icon="inline-start" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={channelToDelete !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteChannel.isPending) {
            setChannelToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {channelToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only empty channels can be removed. The server checks this when
              you delete it, and the channel can be created again later with a
              new ID.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteChannel.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteChannel.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleteChannel.isPending ? "Deleting..." : "Delete channel"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
