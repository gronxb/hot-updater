import type { Bundle } from "@hot-updater/plugin-core";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFilterParams } from "@/hooks/useFilterParams";
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
  onSuccess?: () => void;
}

type PromoteAction = "copy" | "move";

export function PromoteChannelDialog({
  bundle,
  open,
  onOpenChange,
  onSuccess,
}: PromoteChannelDialogProps) {
  const [targetChannel, setTargetChannel] = useState<string>("");
  const [action, setAction] = useState<PromoteAction>("move");

  const { setBundleId } = useFilterParams();
  const { data: channels = [] } = useChannelsQuery();
  const createBundleMutation = useCreateBundleMutation();
  const updateBundleMutation = useUpdateBundleMutation();

  const availableChannels = channels.filter((c) => c !== bundle.channel);
  const isCopy = action === "copy";
  const normalizedTargetChannel = targetChannel.trim();
  const isSameChannel = normalizedTargetChannel === bundle.channel;

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);

    if (!nextOpen) {
      setTargetChannel("");
      setAction("move");
    }
  };

  const openBundleDetail = (nextBundleId: string, nextChannel: string) => {
    setBundleId(nextBundleId, {
      channel: nextChannel,
      offset: "0",
    });
  };

  const handlePromote = async () => {
    if (!normalizedTargetChannel) {
      toast.error("Please select a target channel");
      return;
    }

    if (isSameChannel) {
      toast.error("Target channel must be different from the current channel");
      return;
    }

    try {
      let nextBundleId = bundle.id;

      if (isCopy) {
        nextBundleId = createUUIDv7WithSameTimestamp(bundle.id);

        await createBundleMutation.mutateAsync({
          ...bundle,
          id: nextBundleId,
          channel: normalizedTargetChannel,
        });
      } else {
        await updateBundleMutation.mutateAsync({
          bundleId: bundle.id,
          bundle: { channel: normalizedTargetChannel },
        });
      }

      handleOpenChange(false);
      onSuccess?.();
      toast.success(
        isCopy
          ? `Bundle copied to ${normalizedTargetChannel}`
          : `Bundle moved to ${normalizedTargetChannel}`,
        {
          description: `bundleId: ${nextBundleId}`,
          action: {
            label: "Show Detail",
            onClick: () =>
              openBundleDetail(nextBundleId, normalizedTargetChannel),
          },
        },
      );
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
            <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
              <TriangleAlert className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>Copying creates a new bundle ID</AlertTitle>
              <AlertDescription className="text-amber-800/90 dark:text-amber-200/90">
                The copied bundle will receive a new database ID, which can
                differ from the bundle ID embedded inside the JavaScript bundle.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="target-channel">Target Channel</Label>
            <Input
              id="target-channel"
              value={targetChannel}
              onChange={(event) => setTargetChannel(event.target.value)}
              placeholder="Enter a channel name"
              list="available-channels"
              aria-invalid={isSameChannel}
            />
            <datalist id="available-channels">
              {availableChannels.map((channel) => (
                <option key={channel} value={channel} />
              ))}
            </datalist>
            {availableChannels.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {availableChannels.map((channel) => (
                  <Button
                    key={channel}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setTargetChannel(channel)}
                  >
                    {channel}
                  </Button>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Choose an existing channel or enter a new one.
            </p>
            {isSameChannel && (
              <p className="text-xs text-destructive" role="alert">
                Target channel must be different from the current channel.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={
              !normalizedTargetChannel ||
              isSameChannel ||
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
