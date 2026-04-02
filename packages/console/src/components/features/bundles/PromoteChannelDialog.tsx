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
import { useChannelsQuery, usePromoteBundleMutation } from "@/lib/api";
import { canSdkVersion } from "@/lib/sdkVersionGuard";
import { createUUIDv7 } from "@/lib/extract-timestamp-from-uuidv7";

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
  const [copyBundleId, setCopyBundleId] = useState("");

  const { setBundleId } = useFilterParams();
  const { data: channels = [] } = useChannelsQuery();
  const promoteBundleMutation = usePromoteBundleMutation();

  const availableChannels = channels.filter((c) => c !== bundle.channel);
  const canCopy = canSdkVersion("0.29.0");
  const isCopy = action === "copy";
  const normalizedTargetChannel = targetChannel.trim();
  const isSameChannel = normalizedTargetChannel === bundle.channel;
  const displayedCopyBundleId = copyBundleId || "Generating bundle ID...";
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);

    if (!nextOpen) {
      setTargetChannel("");
      setAction("move");
      setCopyBundleId("");
    }
  };

  const handleActionChange = (value: string) => {
    const nextAction = value as PromoteAction;
    setAction(nextAction);

    if (nextAction === "copy") {
      setCopyBundleId((current) => current || createUUIDv7());
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

    if (isCopy && !canCopy) {
      toast.error(
        "Copy bundle with metadata.json rewrite is only available for hot-updater SDK version 0.29.0 or later.",
      );
      return;
    }

    try {
      const nextBundleId = isCopy ? copyBundleId || createUUIDv7() : undefined;
      const { bundle: promotedBundle } =
        await promoteBundleMutation.mutateAsync({
          action,
          bundleId: bundle.id,
          nextBundleId,
          targetChannel: normalizedTargetChannel,
        });
      const promotedBundleId = promotedBundle.id;

      handleOpenChange(false);
      onSuccess?.();
      toast.success(
        isCopy
          ? `Bundle copied to ${normalizedTargetChannel}`
          : `Bundle moved to ${normalizedTargetChannel}`,
        {
          description: `bundleId: ${promotedBundleId}`,
          action: {
            label: "Show Detail",
            onClick: () =>
              openBundleDetail(promotedBundleId, normalizedTargetChannel),
          },
        },
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to promote bundle",
      );
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
            <Select value={action} onValueChange={handleActionChange}>
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
                ? canCopy
                  ? "Create a new bundle in the target channel and keep the original in the current channel."
                  : "Copy bundle with metadata.json rewrite is only available for hot-updater SDK version 0.29.0 or later."
                : "Move the current bundle to the target channel without creating a new bundle ID."}
            </p>
          </div>

          {isCopy && (
            <div className="space-y-2">
              <Label htmlFor="copy-bundle-id">New Bundle ID</Label>
              <Input
                id="copy-bundle-id"
                value={displayedCopyBundleId}
                readOnly
              />
              <p className="font-mono text-xs text-muted-foreground">
                {displayedCopyBundleId}
              </p>
            </div>
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
              (isCopy && !canCopy) ||
              (isCopy && !copyBundleId) ||
              isSameChannel ||
              promoteBundleMutation.isPending
            }
          >
            {isCopy ? "Copy" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
