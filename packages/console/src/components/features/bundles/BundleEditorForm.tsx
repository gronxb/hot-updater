import type { Bundle } from "@hot-updater/plugin-core";
import { useForm } from "@tanstack/react-form";
import { Plus, Trash2, TrendingUp, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-[var(--spacing-section)]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-[var(--spacing-section)]"
      >
        {/* Basic Information Section */}
        <Card variant="subtle">
          <CardHeader className="pb-[var(--spacing-component)]">
            <CardTitle className="text-[length:var(--text-h3)]">
              Basic Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-[var(--spacing-component)]">
            <form.Field name="message">
              {(field) => (
                <div className="space-y-[var(--spacing-element)]">
                  <Label
                    htmlFor="message"
                    className="text-[length:var(--text-body)] font-medium"
                  >
                    Update Message
                  </Label>
                  <Textarea
                    id="message"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Describe the changes in this update..."
                    rows={3}
                    className="resize-none"
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="targetAppVersion">
              {(field) => (
                <div className="space-y-[var(--spacing-element)]">
                  <Label
                    htmlFor="targetAppVersion"
                    className="text-[length:var(--text-body)] font-medium"
                  >
                    Target App Version
                  </Label>
                  <Input
                    id="targetAppVersion"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="1.0.0"
                  />
                  <p className="text-[length:var(--text-small)] text-muted-foreground">
                    The app version that will receive this update
                  </p>
                </div>
              )}
            </form.Field>

            {bundle.fingerprintHash && (
              <div className="space-y-[var(--spacing-element)]">
                <Label className="text-[length:var(--text-body)] font-medium">
                  Fingerprint Hash
                </Label>
                <Input
                  value={bundle.fingerprintHash}
                  disabled
                  className="font-mono text-[length:var(--text-small)] bg-muted"
                />
                <p className="text-[length:var(--text-small)] text-muted-foreground">
                  Unique identifier for this bundle build
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deployment Settings Section */}
        <Card variant="subtle">
          <CardHeader className="pb-[var(--spacing-component)]">
            <CardTitle className="text-[length:var(--text-h3)]">
              Deployment Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-[var(--spacing-component)]">
            <form.Field name="enabled">
              {(field) => (
                <div className="flex items-center justify-between py-[var(--spacing-element)]">
                  <div className="space-y-[var(--spacing-tight)]">
                    <Label
                      htmlFor="enabled"
                      className="text-[length:var(--text-body)] font-medium"
                    >
                      Enable Bundle
                    </Label>
                    <p className="text-[length:var(--text-small)] text-muted-foreground">
                      Control whether devices can download this update
                    </p>
                  </div>
                  <Switch
                    id="enabled"
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                  />
                </div>
              )}
            </form.Field>

            <Separator />

            <form.Field name="shouldForceUpdate">
              {(field) => (
                <div className="flex items-center justify-between py-[var(--spacing-element)]">
                  <div className="space-y-[var(--spacing-tight)]">
                    <Label
                      htmlFor="shouldForceUpdate"
                      className="text-[length:var(--text-body)] font-medium"
                    >
                      Force Update
                    </Label>
                    <p className="text-[length:var(--text-small)] text-muted-foreground">
                      Require app restart to apply this update
                    </p>
                  </div>
                  <Switch
                    id="shouldForceUpdate"
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                  />
                </div>
              )}
            </form.Field>

            <Separator />

            <form.Field name="rolloutPercentage">
              {(field) => (
                <div className="space-y-[var(--spacing-component)]">
                  <div className="flex items-center justify-between">
                    <div className="space-y-[var(--spacing-tight)]">
                      <Label
                        htmlFor="rolloutPercentage"
                        className="text-[length:var(--text-body)] font-medium"
                      >
                        Rollout Percentage
                      </Label>
                      <p className="text-[length:var(--text-small)] text-muted-foreground">
                        Gradually roll out to a percentage of devices
                      </p>
                    </div>
                    <Badge variant="outline" className="font-semibold">
                      {field.state.value}%
                    </Badge>
                  </div>
                  <Slider
                    id="rolloutPercentage"
                    value={[field.state.value]}
                    onValueChange={([value]) => field.handleChange(value)}
                    min={0}
                    max={100}
                    step={5}
                    className="py-[var(--spacing-element)]"
                  />
                </div>
              )}
            </form.Field>
          </CardContent>
        </Card>

        {/* Device Targeting Section */}
        <Card variant="subtle">
          <CardHeader className="pb-[var(--spacing-component)]">
            <CardTitle className="text-[length:var(--text-h3)]">
              Device Targeting
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form.Field name="targetDeviceIds">
              {(field) => (
                <div className="space-y-[var(--spacing-component)]">
                  <div className="space-y-[var(--spacing-element)]">
                    <Label className="text-[length:var(--text-body)] font-medium">
                      Target Specific Devices (Optional)
                    </Label>
                    <p className="text-[length:var(--text-small)] text-muted-foreground">
                      If specified, only these devices will receive the update
                    </p>
                  </div>

                  <div className="flex gap-[var(--spacing-element)]">
                    <Input
                      value={newDeviceId}
                      onChange={(e) => setNewDeviceId(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Enter device ID and press Enter..."
                      className="font-mono text-[length:var(--text-small)]"
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
                    <>
                      <div className="flex flex-wrap gap-[var(--spacing-element)] p-[var(--spacing-component)] bg-muted/30 rounded-md border">
                        {field.state.value.map((deviceId: string) => (
                          <Badge
                            key={deviceId}
                            variant="secondary"
                            className="font-mono text-[length:var(--text-small)] gap-1 pr-1"
                          >
                            {deviceId.length > 24
                              ? `${deviceId.slice(0, 24)}...`
                              : deviceId}
                            <button
                              type="button"
                              onClick={() => handleRemoveDeviceId(deviceId)}
                              className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5 transition-colors"
                              aria-label={`Remove ${deviceId}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                      <p className="text-[length:var(--text-small)] text-muted-foreground">
                        {field.state.value.length} device
                        {field.state.value.length !== 1 ? "s" : ""} targeted
                      </p>
                    </>
                  )}
                </div>
              )}
            </form.Field>
          </CardContent>
        </Card>

        <Button
          type="submit"
          className="w-full"
          size="lg"
          disabled={updateBundleMutation.isPending}
        >
          {updateBundleMutation.isPending ? "Saving Changes..." : "Save Changes"}
        </Button>
      </form>

      <Separator />

      {/* Actions Section */}
      <div className="space-y-[var(--spacing-component)]">
        <h3 className="text-[length:var(--text-h3)] font-semibold">
          Bundle Actions
        </h3>
        <div className="grid grid-cols-2 gap-[var(--spacing-element)]">
          <Button
            variant="outline"
            onClick={() => setShowPromoteDialog(true)}
            className="w-full"
          >
            <TrendingUp className="h-4 w-4 mr-2" />
            Promote
          </Button>
          <Button
            variant="destructive"
            onClick={() => setShowDeleteDialog(true)}
            className="w-full"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
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
