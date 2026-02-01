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
import { Switch } from "@/components/ui/switch";
import {
  useChannelsQuery,
  useCreateBundleMutation,
  useDeleteBundleMutation,
} from "@/lib/api";
import { createUUIDv7WithSameTimestamp } from "@/lib/extract-timestamp-from-uuidv7";

interface PromoteChannelDialogProps {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PromoteChannelDialog({
  bundle,
  open,
  onOpenChange,
}: PromoteChannelDialogProps) {
  const [targetChannel, setTargetChannel] = useState<string>("");
  const [isMove, setIsMove] = useState(false);

  const { data: channels = [] } = useChannelsQuery();
  const createBundleMutation = useCreateBundleMutation();
  const deleteBundleMutation = useDeleteBundleMutation();

  const availableChannels = channels.filter((c) => c !== bundle.channel);

  const handlePromote = async () => {
    if (!targetChannel) {
      toast.error("Please select a target channel");
      return;
    }

    try {
      const newBundleId = createUUIDv7WithSameTimestamp(bundle.id);

      await createBundleMutation.mutateAsync({
        ...bundle,
        id: newBundleId,
        channel: targetChannel,
      });

      if (isMove) {
        await deleteBundleMutation.mutateAsync({ bundleId: bundle.id });
        toast.success(
          `Bundle moved from ${bundle.channel} to ${targetChannel}`,
        );
      } else {
        toast.success(
          `Bundle copied from ${bundle.channel} to ${targetChannel}`,
        );
      }

      onOpenChange(false);
      setTargetChannel("");
      setIsMove(false);
    } catch (error) {
      toast.error("Failed to promote bundle");
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to Channel</DialogTitle>
          <DialogDescription>
            {isMove ? "Move" : "Copy"} bundle to a different channel
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
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

          <div className="flex items-center justify-between">
            <Label htmlFor="is-move">Move (delete from source)</Label>
            <Switch id="is-move" checked={isMove} onCheckedChange={setIsMove} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={
              !targetChannel ||
              createBundleMutation.isPending ||
              deleteBundleMutation.isPending
            }
          >
            {isMove ? "Move" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
