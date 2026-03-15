import type { Bundle } from "@hot-updater/plugin-core";
import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useChannelsQuery,
  useCreateBundleMutation,
  useUpdateBundleMutation,
} from "@/lib/api";
import { createUUIDv7WithSameTimestamp } from "@/lib/extract-timestamp-from-uuidv7";

interface PromoteChannelDialogProps {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PromoteAction = "copy" | "move";

export function PromoteChannelDialog({
  bundle,
  open,
  onOpenChange,
}: PromoteChannelDialogProps) {
  const [targetChannel, setTargetChannel] = useState<string>("");
  const [action, setAction] = useState<PromoteAction>("move");

  const { data: channels = [] } = useChannelsQuery();
  const createBundleMutation = useCreateBundleMutation();
  const updateBundleMutation = useUpdateBundleMutation();

  const availableChannels = channels.filter((c) => c !== bundle.channel);
  const isCopy = action === "copy";

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);

    if (!nextOpen) {
      setTargetChannel("");
      setAction("move");
    }
  };

  const handlePromote = async () => {
    if (!targetChannel) {
      toast.error("Please select a target channel");
      return;
    }

    try {
      if (isCopy) {
        const newBundleId = createUUIDv7WithSameTimestamp(bundle.id);

        await createBundleMutation.mutateAsync({
          ...bundle,
          id: newBundleId,
          channel: targetChannel,
        });

        toast.success(
          `Bundle copied from ${bundle.channel} to ${targetChannel}`,
        );
      } else {
        await updateBundleMutation.mutateAsync({
          bundleId: bundle.id,
          bundle: { channel: targetChannel },
        });

        toast.success(
          `Bundle moved from ${bundle.channel} to ${targetChannel}`,
        );
      }

      handleOpenChange(false);
    } catch (error) {
      toast.error("Failed to promote bundle");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to Channel</DialogTitle>
          <DialogDescription>
            Choose how to promote this bundle, then select the target channel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="promote-action">Action</Label>
            <Select
              value={action}
              onValueChange={(value) => setAction(value as PromoteAction)}
            >
              <SelectTrigger id="promote-action">
                <SelectValue placeholder="Select an action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="move">Move bundle</SelectItem>
                <SelectItem value="copy">Copy bundle</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isCopy
                ? "Create a new bundle in the target channel and keep the original in the current channel."
                : "Move the current bundle to the target channel without creating a new bundle ID."}
            </p>
          </div>

          {isCopy && (
            <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
              The copied bundle will receive a new database ID, which can differ
              from the bundle ID embedded inside the JavaScript bundle.
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="target-channel">Target Channel</Label>
            <Select value={targetChannel} onValueChange={setTargetChannel}>
              <SelectTrigger id="target-channel">
                <SelectValue placeholder="Select a channel" />
              </SelectTrigger>
              <SelectContent>
                {availableChannels.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {channel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={
              !targetChannel ||
              createBundleMutation.isPending ||
              updateBundleMutation.isPending
            }
          >
            {isCopy ? "Copy" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
