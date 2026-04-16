import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  normalizeCohortValue,
} from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { useForm, useStore } from "@tanstack/react-form";
import { Download, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import semver from "semver";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useBundleDownloadUrlMutation,
  useUpdateBundleMutation,
} from "@/lib/api";

import { CreateBundleDiffDialog } from "./CreateBundleDiffDialog";
import { DeleteBundleDialog } from "./DeleteBundleDialog";
import { PromoteChannelDialog } from "./PromoteChannelDialog";
import { RolloutCohortsDialog } from "./RolloutCohortsDialog";

interface BundleEditorFormProps {
  bundle: Bundle;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}

type BundleEditorFormValues = {
  message: string;
  targetAppVersion: string;
  enabled: boolean;
  shouldForceUpdate: boolean;
  rolloutCohortCount: number;
  targetCohorts: string[];
};

function getTargetAppVersionValidation(value: string) {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    return {
      error: "Invalid target app version",
      normalizedRange: null,
    };
  }

  const normalizedRange = semver.validRange(normalizedValue);

  if (!normalizedRange) {
    return {
      error: "Invalid target app version",
      normalizedRange: null,
    };
  }

  return {
    error: undefined,
    normalizedRange,
  };
}

function getDefaultValues(bundle: Bundle): BundleEditorFormValues {
  return {
    message: bundle.message || "",
    targetAppVersion: bundle.targetAppVersion || "",
    enabled: bundle.enabled,
    shouldForceUpdate: bundle.shouldForceUpdate,
    rolloutCohortCount:
      bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: bundle.targetCohorts ?? [],
  };
}

const formatRolloutPercentage = (rolloutCohortCount: number) =>
  (rolloutCohortCount / 10).toFixed(1);

export function BundleEditorForm({
  bundle,
  onClose,
  onBusyChange,
}: BundleEditorFormProps) {
  const bundleDownloadUrlMutation = useBundleDownloadUrlMutation();
  const updateBundleMutation = useUpdateBundleMutation();
  const [showCreateDiffDialog, setShowCreateDiffDialog] = useState(false);
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [newCohort, setNewCohort] = useState("");
  const shouldEditTargetAppVersion = Boolean(bundle.targetAppVersion);
  const canCreateDiff =
    Boolean(bundle.metadata?.manifest_storage_uri) &&
    Boolean(bundle.metadata?.asset_base_storage_uri);

  const form = useForm({
    defaultValues: getDefaultValues(bundle),
    onSubmit: async ({ value }) => {
      const targetAppVersion = value.targetAppVersion.trim();
      const { error } = shouldEditTargetAppVersion
        ? getTargetAppVersionValidation(targetAppVersion)
        : { error: undefined };

      if (error) {
        toast.error(error);
        return;
      }

      const normalizedTargetCohorts = Array.from(
        new Set(
          value.targetCohorts.map((cohort) => normalizeCohortValue(cohort)),
        ),
      );
      const invalidCohort = normalizedTargetCohorts.find(
        (cohort) => !isValidCohort(cohort),
      );
      if (invalidCohort) {
        toast.error(INVALID_COHORT_ERROR_MESSAGE);
        return;
      }

      try {
        await updateBundleMutation.mutateAsync({
          bundleId: bundle.id,
          bundle: {
            message: value.message,
            targetAppVersion: targetAppVersion || undefined,
            enabled: value.enabled,
            shouldForceUpdate: value.shouldForceUpdate,
            rolloutCohortCount: value.rolloutCohortCount,
            targetCohorts:
              normalizedTargetCohorts.length > 0
                ? normalizedTargetCohorts
                : null,
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
  const hasChanges = useStore(form.store, (state) => !state.isDefaultValue);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const targetAppVersion = useStore(
    form.store,
    (state) => state.values.targetAppVersion,
  );
  const targetCohorts = useStore(
    form.store,
    (state) => state.values.targetCohorts,
  );
  const isSaving = isSubmitting || updateBundleMutation.isPending;
  const targetAppVersionValidation = shouldEditTargetAppVersion
    ? getTargetAppVersionValidation(targetAppVersion)
    : {
        error: undefined,
        normalizedRange: null,
      };
  const hasTargetAppVersionError = Boolean(targetAppVersionValidation.error);
  const isDownloading = bundleDownloadUrlMutation.isPending;

  useEffect(() => {
    onBusyChange?.(isSaving);
  }, [isSaving, onBusyChange]);

  useEffect(() => {
    return () => {
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  const handleAddCohort = () => {
    const normalizedCohort = normalizeCohortValue(newCohort);
    if (!normalizedCohort) return;

    if (!isValidCohort(normalizedCohort)) {
      toast.error(INVALID_COHORT_ERROR_MESSAGE);
      return;
    }

    const currentCohorts = form.getFieldValue("targetCohorts");
    if (currentCohorts.includes(normalizedCohort)) {
      toast.error("Cohort already exists");
      return;
    }

    form.setFieldValue("targetCohorts", [...currentCohorts, normalizedCohort]);
    setNewCohort("");
  };

  const handleRemoveCohort = (cohortToRemove: string) => {
    const currentCohorts = form.getFieldValue("targetCohorts");
    form.setFieldValue(
      "targetCohorts",
      currentCohorts.filter((cohort: string) => cohort !== cohortToRemove),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddCohort();
    }
  };

  const handleDownloadBundle = async () => {
    const downloadWindow = window.open("", "_blank");

    try {
      const { fileUrl } = await bundleDownloadUrlMutation.mutateAsync({
        bundleId: bundle.id,
      });

      if (!fileUrl) {
        throw new Error("Bundle download URL is empty");
      }

      if (downloadWindow) {
        downloadWindow.opener = null;
        downloadWindow.location.href = fileUrl;
      } else {
        window.open(fileUrl, "_blank", "noopener,noreferrer");
      }
      toast.success("Bundle download started");
    } catch (error) {
      downloadWindow?.close();
      const message =
        error instanceof Error ? error.message : "Failed to download bundle";
      toast.error(message);
      console.error(error);
    }
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (
            form.state.isDefaultValue ||
            isSaving ||
            hasTargetAppVersionError
          ) {
            return;
          }
          form.handleSubmit();
        }}
        className="space-y-6"
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

        {shouldEditTargetAppVersion && (
          <form.Field name="targetAppVersion">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="targetAppVersion">Target App Version</Label>
                <Input
                  id="targetAppVersion"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="1.0.0"
                  aria-invalid={hasTargetAppVersionError}
                />
                {hasTargetAppVersionError ? (
                  <p className="text-xs text-destructive" role="alert">
                    {targetAppVersionValidation.error}
                  </p>
                ) : (
                  targetAppVersionValidation.normalizedRange && (
                    <p className="text-xs text-muted-foreground">
                      {targetAppVersionValidation.normalizedRange}
                    </p>
                  )
                )}
              </div>
            )}
          </form.Field>
        )}

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

        <form.Field name="rolloutCohortCount">
          {(field) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rolloutCohortCount">Rollout Percentage</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {formatRolloutPercentage(field.state.value)}%
                  </span>
                  <RolloutCohortsDialog
                    bundleId={bundle.id}
                    rolloutCohortCount={field.state.value}
                    targetCohorts={targetCohorts}
                    triggerLabel="Preview Cohorts"
                    triggerVariant="outline"
                    triggerSize="sm"
                  />
                </div>
              </div>
              <Slider
                id="rolloutCohortCount"
                value={[field.state.value]}
                onValueChange={([value]) => field.handleChange(value)}
                min={0}
                max={1000}
                step={1}
                className="mt-2"
              />
            </div>
          )}
        </form.Field>

        <form.Field name="targetCohorts">
          {(field) => (
            <div className="space-y-2">
              <Label>Target Cohorts (optional)</Label>
              <div className="flex gap-2">
                <Input
                  value={newCohort}
                  onChange={(e) => setNewCohort(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter cohort..."
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleAddCohort}
                  disabled={!newCohort.trim()}
                  aria-label="Add cohort"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {field.state.value.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {field.state.value.map((cohort: string) => (
                    <Badge
                      key={cohort}
                      variant="secondary"
                      className="font-mono text-xs gap-1 pr-1"
                    >
                      {cohort.length > 20
                        ? `${cohort.slice(0, 20)}...`
                        : cohort}
                      <button
                        type="button"
                        onClick={() => handleRemoveCohort(cohort)}
                        aria-label={`Remove cohort ${cohort}`}
                        className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {field.state.value.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  {field.state.value.length} cohort
                  {field.state.value.length !== 1 ? "s" : ""} targeted
                </p>
              )}
            </div>
          )}
        </form.Field>

        <div className="pt-2">
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={!hasChanges || isSaving || hasTargetAppVersionError}
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>

      <Separator className="my-8" />

      <div className="space-y-4">
        <h3 className="text-sm font-medium">Actions</h3>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setShowCreateDiffDialog(true)}
          disabled={!canCreateDiff}
        >
          Create HBC Diff
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setShowPromoteDialog(true)}
          disabled={isSaving}
        >
          Promote to Channel
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={handleDownloadBundle}
          disabled={isSaving || isDownloading}
        >
          <Download className="h-4 w-4" />
          {isDownloading ? "Preparing Download..." : "Download Bundle"}
        </Button>

        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => setShowDeleteDialog(true)}
          disabled={isSaving}
        >
          Delete Bundle
        </Button>
      </div>

      <CreateBundleDiffDialog
        bundle={bundle}
        open={showCreateDiffDialog}
        onOpenChange={setShowCreateDiffDialog}
      />

      <PromoteChannelDialog
        bundle={bundle}
        open={showPromoteDialog}
        onOpenChange={setShowPromoteDialog}
        onSuccess={onClose}
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
