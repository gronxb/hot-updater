// allow: SIZE_OK — existing dialog owns promote flow state; G004 adds capability gating only.
import type { Bundle } from "@hot-updater/plugin-core";
import { createUUIDv7 } from "@hot-updater/plugin-core";
import { useEffect, useState } from "react";
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
import { useCapabilitiesQuery } from "@/lib/useCapabilities";

interface PromoteChannelDialogProps {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type PromoteAction = "copy" | "move";

const isPromoteAction = (value: string): value is PromoteAction =>
  value === "copy" || value === "move";

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
  const { data: capabilities } = useCapabilitiesQuery();
  const promoteBundleMutation = usePromoteBundleMutation();
  const isPromoting = promoteBundleMutation.isPending;
  const moveCapability = capabilities?.promoteBundleMove;
  const copyCapability = capabilities?.promoteBundleCopy;
  const canMove = moveCapability?.supported === true;
  const canCopy = copyCapability?.supported === true;
  const canPromote = canMove || canCopy;

  const availableChannels = channels.filter((c) => c !== bundle.channel);
  const isCopy = action === "copy";
  const actionCapability = isCopy ? copyCapability : moveCapability;
  const normalizedTargetChannel = targetChannel.trim();
  const isSameChannel = normalizedTargetChannel === bundle.channel;
  const displayedCopyBundleId = copyBundleId || "Generating bundle ID...";

  const resetDialogState = () => {
    setTargetChannel("");
    setAction("move");
    setCopyBundleId("");
  };

  const closeDialog = () => {
    onOpenChange(false);
    resetDialogState();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isPromoting) {
      return;
    }

    onOpenChange(nextOpen);

    if (!nextOpen) {
      resetDialogState();
    }
  };

  const handleActionChange = (value: string) => {
    if (!isPromoteAction(value)) {
      return;
    }

    const nextAction = value;
    if (nextAction === "copy" && !canCopy) {
      return;
    }
    if (nextAction === "move" && !canMove) {
      return;
    }

    setAction(nextAction);

    if (nextAction === "copy") {
      setCopyBundleId((current) => current || createUUIDv7());
    }
  };

  const openBundleDetail = (nextBundleId: string, nextChannel: string) => {
    setBundleId(nextBundleId, {
      channel: nextChannel,
      after: undefined,
      before: undefined,
    });
  };

  const handlePromote = async () => {
    if (!capabilities || !actionCapability?.supported) {
      toast.error(
        actionCapability?.reason ?? "Console capabilities are still loading",
      );
      return;
    }

    if (!normalizedTargetChannel) {
      toast.error("Please select a target channel");
      return;
    }

    if (isSameChannel) {
      toast.error("Target channel must be different from the current channel");
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

      closeDialog();
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

  useEffect(() => {
    if (!open || !capabilities) {
      return;
    }

    if (action === "move" && !canMove && canCopy) {
      setAction("copy");
      setCopyBundleId((current) => current || createUUIDv7());
    }

    if (action === "copy" && !canCopy && canMove) {
      setAction("move");
      setCopyBundleId("");
    }
  }, [action, canCopy, canMove, capabilities, open]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isPromoting}
        onEscapeKeyDown={(event) => {
          if (isPromoting) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isPromoting) {
            event.preventDefault();
          }
        }}
      >
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
              onValueChange={handleActionChange}
              disabled={isPromoting || !capabilities || !canPromote}
            >
              <SelectTrigger
                id="promote-action"
                disabled={isPromoting || !capabilities || !canPromote}
              >
                <SelectValue placeholder="Select an action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="move" disabled={!canMove}>
                  Move bundle
                </SelectItem>
                <SelectItem value="copy" disabled={!canCopy}>
                  Copy bundle
                </SelectItem>
              </SelectContent>
            </Select>
            {actionCapability?.supported === false ? (
              <p className="text-xs text-destructive" role="alert">
                {actionCapability.reason}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {isCopy
                ? "Create a new bundle in the target channel and keep the original in the current channel."
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
                disabled={isPromoting || !canCopy}
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
              disabled={isPromoting || !capabilities || !canPromote}
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
                    aria-label={`Use ${channel} as target channel`}
                    onClick={() => setTargetChannel(channel)}
                    disabled={isPromoting || !capabilities || !canPromote}
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
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPromoting}
          >
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={
              !normalizedTargetChannel ||
              (isCopy && !copyBundleId) ||
              isSameChannel ||
              !capabilities ||
              !canPromote ||
              !actionCapability?.supported ||
              isPromoting
            }
          >
            {isPromoting
              ? isCopy
                ? "Copying..."
                : "Moving..."
              : isCopy
                ? "Copy"
                : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
