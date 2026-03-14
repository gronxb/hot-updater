import type { Bundle } from "@hot-updater/plugin-core";
import { useForm } from "@tanstack/react-form";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateBundleMutation } from "@/lib/api";
import { DeleteBundleDialog } from "./DeleteBundleDialog";
import { PromoteChannelDialog } from "./PromoteChannelDialog";

interface BundleEditorFormProps {
  bundle: Bundle;
  onClose: () => void;
}

export function BundleEditorForm({ bundle, onClose }: BundleEditorFormProps) {
  const updateBundleMutation = useUpdateBundleMutation();
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [newDeviceId, setNewDeviceId] = useState("");

  const form = useForm({
    defaultValues: {
      message: bundle.message || "",
      targetAppVersion: bundle.targetAppVersion || "",
      enabled: bundle.enabled,
      shouldForceUpdate: bundle.shouldForceUpdate,
      rolloutPercentage: bundle.rolloutPercentage ?? 100,
      targetDeviceIds: bundle.targetDeviceIds ?? [],
    },
    onSubmit: async ({ value }) => {
      try {
        await updateBundleMutation.mutateAsync({
          bundleId: bundle.id,
          bundle: {
            message: value.message,
            targetAppVersion: value.targetAppVersion,
            enabled: value.enabled,
            shouldForceUpdate: value.shouldForceUpdate,
            rolloutPercentage: value.rolloutPercentage,
            targetDeviceIds:
              value.targetDeviceIds.length > 0
                ? value.targetDeviceIds
                : undefined,
          },
        });
        toast.success("Bundle updated successfully");
        onClose();
      } catch (error) {
        toast.error("Failed to update bundle");
        console.error(error);
      }
    },
  });

  const handleAddDeviceId = () => {
    const trimmed = newDeviceId.trim();
    if (!trimmed) return;

    const currentIds = form.getFieldValue("targetDeviceIds");
    if (currentIds.includes(trimmed)) {
      toast.error("Device ID already exists");
      return;
    }

    form.setFieldValue("targetDeviceIds", [...currentIds, trimmed]);
    setNewDeviceId("");
  };

  const handleRemoveDeviceId = (idToRemove: string) => {
    const currentIds = form.getFieldValue("targetDeviceIds");
    form.setFieldValue(
      "targetDeviceIds",
      currentIds.filter((id: string) => id !== idToRemove),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddDeviceId();
    }
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-4"
      >
        <form.Field name="message">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Update message..."
                rows={3}
              />
            </div>
          )}
        </form.Field>

        <form.Field name="targetAppVersion">
          {(field) => (
            <div className="space-y-2">
              <Label htmlFor="targetAppVersion">Target App Version</Label>
              <Input
                id="targetAppVersion"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
          )}
        </form.Field>

        {bundle.fingerprintHash && (
          <div className="space-y-2">
            <Label>Fingerprint Hash</Label>
            <Input
              value={bundle.fingerprintHash}
              disabled
              className="font-mono text-xs"
            />
          </div>
        )}

        <form.Field name="enabled">
          {(field) => (
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled">Enabled</Label>
              <Switch
                id="enabled"
                checked={field.state.value}
                onCheckedChange={field.handleChange}
              />
            </div>
          )}
        </form.Field>

        <form.Field name="shouldForceUpdate">
          {(field) => (
            <div className="flex items-center justify-between">
              <Label htmlFor="shouldForceUpdate">Force Update</Label>
              <Switch
                id="shouldForceUpdate"
                checked={field.state.value}
                onCheckedChange={field.handleChange}
              />
            </div>
          )}
        </form.Field>

        <form.Field name="rolloutPercentage">
          {(field) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rolloutPercentage">Rollout Percentage</Label>
                <span className="text-sm font-medium">
                  {field.state.value}%
                </span>
              </div>
              <Slider
                id="rolloutPercentage"
                value={[field.state.value]}
                onValueChange={([value]) => field.handleChange(value)}
                min={0}
                max={100}
                step={1}
              />
            </div>
          )}
        </form.Field>

        <form.Field name="targetDeviceIds">
          {(field) => (
            <div className="space-y-2">
              <Label>Target Device IDs (optional)</Label>
              <div className="flex gap-2">
                <Input
                  value={newDeviceId}
                  onChange={(e) => setNewDeviceId(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter device ID..."
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleAddDeviceId}
                  disabled={!newDeviceId.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {field.state.value.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {field.state.value.map((deviceId: string) => (
                    <Badge
                      key={deviceId}
                      variant="secondary"
                      className="font-mono text-xs gap-1 pr-1"
                    >
                      {deviceId.length > 20
                        ? `${deviceId.slice(0, 20)}...`
                        : deviceId}
                      <button
                        type="button"
                        onClick={() => handleRemoveDeviceId(deviceId)}
                        className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {field.state.value.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {field.state.value.length} device
                  {field.state.value.length !== 1 ? "s" : ""} targeted
                </p>
              )}
            </div>
          )}
        </form.Field>

        <Button
          type="submit"
          className="w-full"
          disabled={updateBundleMutation.isPending}
        >
          {updateBundleMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </form>

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Actions</h3>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setShowPromoteDialog(true)}
        >
          Promote to Channel
        </Button>

        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => setShowDeleteDialog(true)}
        >
          Delete Bundle
        </Button>
      </div>

      <PromoteChannelDialog
        bundle={bundle}
        open={showPromoteDialog}
        onOpenChange={setShowPromoteDialog}
      />

      <DeleteBundleDialog
        bundle={bundle}
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onSuccess={onClose}
      />
    </div>
  );
}
