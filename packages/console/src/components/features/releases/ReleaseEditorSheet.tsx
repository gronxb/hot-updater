import {
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  normalizeCohortValue,
} from "@hot-updater/core";
import type {
  ChannelRow,
  ReleasePolicyPatch,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { AlertTriangle, Download, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { normalizeRange } from "verkit";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { BundleInsightsSummary } from "@/components/features/bundles/BundleInsightsSummary";
import { BundleMetadata } from "@/components/features/bundles/BundleMetadata";
import { RolloutCohortsDialog } from "@/components/features/bundles/RolloutCohortsDialog";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useBundleQuery,
  useDeleteReleaseMutation,
  usePreflightReleaseMutation,
  usePromoteReleaseMutation,
  useReleaseCatalogDiagnosticsQuery,
  useReleaseQuery,
  useUpdateReleaseMutation,
} from "@/lib/api";

interface Draft {
  enabled: boolean;
  message: string;
  rolloutCohortCount: number;
  shouldForceUpdate: boolean;
  targetAppVersion: string;
  targetCohorts: string[];
}

const promoteActionItems = [
  { label: "Move bundle", value: "move" },
  { label: "Copy bundle", value: "copy" },
];

const draftFromRelease = (release: ReleaseRow): Draft => ({
  enabled: release.enabled,
  message: release.message ?? "",
  rolloutCohortCount: release.rollout_cohort_count,
  shouldForceUpdate: release.should_force_update,
  targetAppVersion: release.target_app_version ?? "",
  targetCohorts: [...release.target_cohorts],
});

const patchFromDraft = (
  release: ReleaseRow,
  draft: Draft,
): ReleasePolicyPatch => ({
  enabled: draft.enabled,
  message: draft.message.trim() || null,
  rolloutCohortCount: draft.rolloutCohortCount,
  shouldForceUpdate: draft.shouldForceUpdate,
  ...(release.strategy === "APP_VERSION"
    ? { targetAppVersion: draft.targetAppVersion.trim() }
    : {}),
  targetCohorts: draft.targetCohorts,
});

const formatRolloutPercentage = (count: number) => (count / 10).toFixed(1);

const formatRolloutInput = (value: string) => {
  const normalized = value.replace(",", ".");
  const [integer = "", ...decimals] = normalized.split(".");
  const integerDigits = integer.replace(/\D/g, "").slice(0, 3);
  const decimalDigit = decimals.join("").replace(/\D/g, "").slice(0, 1);
  return normalized.includes(".")
    ? `${integerDigits}.${decimalDigit}`
    : integerDigits;
};

const parseRolloutInput = (value: string) => {
  const percentage = Number.parseFloat(value);
  if (!Number.isFinite(percentage)) return null;
  return Math.min(1_000, Math.max(0, Math.trunc(percentage * 10)));
};

function RolloutPercentageInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [inputValue, setInputValue] = useState(formatRolloutPercentage(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setInputValue(formatRolloutPercentage(value));
  }, [focused, value]);

  const commitInput = () => {
    const nextValue = parseRolloutInput(inputValue) ?? value;
    setFocused(false);
    setInputValue(formatRolloutPercentage(nextValue));
    onChange(nextValue);
  };

  return (
    <div className="flex items-center gap-3">
      <Slider
        aria-label="Rollout percentage"
        max={1_000}
        min={0}
        onValueChange={(nextValue) =>
          onChange(
            Array.isArray(nextValue) ? (nextValue[0] ?? value) : nextValue,
          )
        }
        step={1}
        value={value}
      />
      <InputGroup className="w-24 shrink-0">
        <InputGroupInput
          aria-label="Rollout percentage"
          autoComplete="off"
          className="text-right tabular-nums"
          id="release-rollout-percentage"
          inputMode="decimal"
          name="rolloutPercentage"
          onBlur={commitInput}
          onChange={(event) => {
            const nextInput = formatRolloutInput(event.target.value);
            setInputValue(nextInput);
            const parsed = parseRolloutInput(nextInput);
            if (parsed !== null) onChange(parsed);
          }}
          onFocus={() => setFocused(true)}
          value={inputValue}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>%</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export function ReleaseEditorSheet({
  channels,
  onOpenChange,
  open,
  releaseId,
}: {
  channels: readonly ChannelRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  releaseId: string;
}) {
  const releaseQuery = useReleaseQuery(releaseId);
  const release = releaseQuery.data;
  const bundleQuery = useBundleQuery(release?.bundle_id ?? "");
  const bundle = bundleQuery.data;
  const diagnostics = useReleaseCatalogDiagnosticsQuery(
    release?.scope_key ?? "",
  );
  const update = useUpdateReleaseMutation();
  const preflight = usePreflightReleaseMutation();
  const remove = useDeleteReleaseMutation();
  const promote = usePromoteReleaseMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newCohort, setNewCohort] = useState("");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [targetChannel, setTargetChannel] = useState("");
  const [promoteAction, setPromoteAction] = useState<"copy" | "move">("move");

  useEffect(() => {
    setDraft(release ? draftFromRelease(release) : null);
    setError("");
  }, [release]);

  const initialDraft = release ? draftFromRelease(release) : null;
  const dirty =
    draft !== null &&
    initialDraft !== null &&
    JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const busy =
    preflight.isPending ||
    update.isPending ||
    remove.isPending ||
    promote.isPending;

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const addCohort = () => {
    if (!draft) return;
    const cohort = normalizeCohortValue(newCohort);
    if (!isValidCohort(cohort)) {
      setError(INVALID_COHORT_ERROR_MESSAGE);
      return;
    }
    setDraft({
      ...draft,
      targetCohorts: Array.from(new Set([...draft.targetCohorts, cohort])),
    });
    setNewCohort("");
    setError("");
  };

  const save = async () => {
    if (!release || !draft) return;
    const cohorts = draft.targetCohorts.map(normalizeCohortValue);
    if (cohorts.some((cohort) => !isValidCohort(cohort))) {
      setError(INVALID_COHORT_ERROR_MESSAGE);
      return;
    }
    if (
      release.strategy === "APP_VERSION" &&
      !normalizeRange(draft.targetAppVersion.trim())
    ) {
      setError("Enter a valid target app version range.");
      return;
    }
    const input = {
      expectedRevision: release.revision,
      patch: patchFromDraft(release, { ...draft, targetCohorts: cohorts }),
      releaseId: release.id,
    };
    setError("");
    try {
      await preflight.mutateAsync(input);
      await update.mutateAsync(input);
      toast.success("Bundle settings saved");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Bundle settings could not be saved.",
      );
    }
  };

  const channelName =
    channels.find((channel) => channel.id === release?.channel_id)?.name ??
    release?.channel_id;
  const availableChannels = channels.filter(
    (channel) => channel.id !== release?.channel_id,
  );
  const availableChannelItems = availableChannels.map((channel) => ({
    label: channel.name,
    value: channel.name,
  }));
  const normalizedTargetChannel = targetChannel.trim();
  const isCopyPromotion = promoteAction === "copy";
  const normalizedTargetAppVersion = draft
    ? normalizeRange(draft.targetAppVersion.trim())
    : null;

  const resetPromoteDialog = () => {
    setTargetChannel("");
    setPromoteAction("move");
  };

  const handlePromoteOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && promote.isPending) return;
    setShowPromote(nextOpen);
    if (!nextOpen) resetPromoteDialog();
  };

  return (
    <>
      <Sheet
        onOpenChange={(nextOpen) => (nextOpen ? undefined : requestClose())}
        open={open}
      >
        <SheetContent className="min-w-0 overflow-hidden data-[side=right]:w-full sm:max-w-[600px]">
          <SheetHeader className="shrink-0 pr-12">
            <SheetTitle>Bundle Detail</SheetTitle>
            <SheetDescription className="sr-only">
              Edit bundle delivery settings.
            </SheetDescription>
            {release ? (
              <div className="mt-1 flex min-w-0 flex-col gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2">
                    <PlatformIcon
                      className="size-4"
                      platform={release.platform}
                    />
                    <span className="font-medium">
                      {release.platform === "ios" ? "iOS" : "Android"}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="font-medium text-muted-foreground">
                    Bundle
                  </span>
                  <span className="min-w-0 basis-full sm:basis-auto">
                    {release.bundle_id ? (
                      <BundleIdDisplay
                        bundleId={release.bundle_id}
                        fullOnMobile
                        maxLength={18}
                      />
                    ) : (
                      <span className="text-xs text-foreground">
                        Built-in app
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-muted-foreground">
                    Channel
                  </span>
                  <span className="text-xs text-foreground" translate="no">
                    {channelName}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-muted-foreground">
                    Platform
                  </span>
                  <span className="text-xs text-foreground">
                    {release.platform === "ios" ? "iOS" : "Android"}
                  </span>
                </div>
              </div>
            ) : (
              <Skeleton className="h-12 w-full" />
            )}
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {releaseQuery.isError ? (
              <Alert className="m-4 sm:m-6" variant="destructive">
                <AlertTriangle />
                <AlertTitle>Bundle details could not be loaded</AlertTitle>
                <AlertDescription>
                  {releaseQuery.error.message}
                </AlertDescription>
              </Alert>
            ) : null}

            {release && draft ? (
              <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6 sm:pb-6">
                {release.bundle_id ? (
                  <BundleInsightsSummary bundleId={release.bundle_id} />
                ) : null}

                <section
                  aria-labelledby="delivery-settings-heading"
                  className="flex flex-col gap-4"
                >
                  <h3
                    className="text-sm font-medium"
                    id="delivery-settings-heading"
                  >
                    Delivery settings
                  </h3>
                  <FieldGroup className="gap-6">
                    <Field>
                      <FieldLabel htmlFor="release-message">Message</FieldLabel>
                      <Textarea
                        autoComplete="off"
                        id="release-message"
                        name="message"
                        onChange={(event) =>
                          setDraft({ ...draft, message: event.target.value })
                        }
                        rows={3}
                        value={draft.message}
                      />
                    </Field>
                    {release.strategy === "APP_VERSION" ? (
                      <Field>
                        <FieldLabel htmlFor="release-target">
                          Target app version
                        </FieldLabel>
                        <Input
                          autoComplete="off"
                          id="release-target"
                          name="targetAppVersion"
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              targetAppVersion: event.target.value,
                            })
                          }
                          value={draft.targetAppVersion}
                        />
                        {normalizedTargetAppVersion ? (
                          <FieldDescription>
                            {normalizedTargetAppVersion}
                          </FieldDescription>
                        ) : null}
                      </Field>
                    ) : null}
                    <Field>
                      <div className="flex items-center justify-between gap-4">
                        <FieldLabel htmlFor="release-enabled">
                          Enabled
                        </FieldLabel>
                        <Switch
                          aria-label="Enabled"
                          checked={draft.enabled}
                          id="release-enabled"
                          name="enabled"
                          onCheckedChange={(enabled) =>
                            setDraft({ ...draft, enabled })
                          }
                        />
                      </div>
                      <FieldDescription>
                        Disabling rolls devices back to the previous enabled
                        Release on their next check, or to the built-in app when
                        none remains.
                      </FieldDescription>
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="release-force-update">
                        Force update
                      </FieldLabel>
                      <Switch
                        aria-label="Force update"
                        checked={draft.shouldForceUpdate}
                        id="release-force-update"
                        name="shouldForceUpdate"
                        onCheckedChange={(shouldForceUpdate) =>
                          setDraft({ ...draft, shouldForceUpdate })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="release-rollout-percentage">
                        Rollout percentage
                      </FieldLabel>
                      <RolloutPercentageInput
                        onChange={(rolloutCohortCount) =>
                          setDraft({ ...draft, rolloutCohortCount })
                        }
                        value={draft.rolloutCohortCount}
                      />
                    </Field>
                    <Field>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldLabel htmlFor="release-cohort">
                          Additional cohorts (optional)
                        </FieldLabel>
                        <RolloutCohortsDialog
                          releaseId={release.id}
                          rolloutCohortCount={draft.rolloutCohortCount}
                          targetCohorts={draft.targetCohorts}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Input
                          autoComplete="off"
                          id="release-cohort"
                          name="targetCohort"
                          onChange={(event) => setNewCohort(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addCohort();
                            }
                          }}
                          placeholder="e.g. qa-team…"
                          value={newCohort}
                        />
                        <Button
                          aria-label="Add cohort"
                          disabled={!newCohort.trim()}
                          onClick={addCohort}
                          size="icon"
                          type="button"
                          variant="outline"
                        >
                          <Plus />
                        </Button>
                      </div>
                      {draft.targetCohorts.length ? (
                        <div className="flex flex-wrap gap-2">
                          {draft.targetCohorts.map((cohort) => (
                            <Badge
                              className="gap-1 font-mono"
                              key={cohort}
                              variant="secondary"
                            >
                              {cohort}
                              <button
                                aria-label={`Remove cohort ${cohort}`}
                                className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() =>
                                  setDraft({
                                    ...draft,
                                    targetCohorts: draft.targetCohorts.filter(
                                      (value) => value !== cohort,
                                    ),
                                  })
                                }
                                type="button"
                              >
                                <X className="size-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      <FieldDescription>
                        Public names—no IDs or secrets.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                  {error ? <FieldError>{error}</FieldError> : null}
                  <Button
                    className="w-full"
                    disabled={!dirty || busy}
                    onClick={save}
                    size="lg"
                  >
                    {preflight.isPending || update.isPending
                      ? "Saving…"
                      : "Save changes"}
                  </Button>
                </section>

                <Separator className="my-2" />

                <section className="flex flex-col gap-4">
                  <h3 className="text-sm font-medium">Actions</h3>
                  <Button
                    className="w-full"
                    disabled={release.kind !== "BUNDLE" || busy}
                    onClick={() => setShowPromote(true)}
                    size="sm"
                    variant="outline"
                  >
                    Promote to channel
                  </Button>
                  {release.bundle_id ? (
                    <Button
                      className="w-full"
                      disabled={busy}
                      onClick={() => {
                        window.open(
                          `/api/bundles/${encodeURIComponent(release.bundle_id!)}/download`,
                          "_blank",
                          "noopener,noreferrer",
                        );
                        toast.success("Bundle download started");
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Download data-icon="inline-start" />
                      Download bundle
                    </Button>
                  ) : null}
                  <Button
                    className="w-full"
                    disabled={release.enabled || busy}
                    onClick={() => setConfirmDelete(true)}
                    size="sm"
                    variant="destructive"
                  >
                    Remove from channel
                  </Button>
                </section>

                {release.bundle_id && bundleQuery.isPending ? (
                  <Skeleton className="h-40 w-full" />
                ) : null}
                {release.bundle_id && bundleQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertTitle>Build details are unavailable</AlertTitle>
                    <AlertDescription>
                      Delivery settings are unaffected.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {!release.bundle_id || !bundleQuery.isPending ? (
                  <BundleMetadata bundle={bundle} release={release} />
                ) : null}

                <details className="rounded-lg border bg-muted/10 p-4 text-xs">
                  <summary className="cursor-pointer font-medium">
                    Advanced diagnostics
                  </summary>
                  <dl className="mt-4 grid gap-3 text-muted-foreground sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <dt>Release ID</dt>
                      <dd className="mt-1 break-all font-mono text-foreground">
                        {release.id}
                      </dd>
                    </div>
                    <div>
                      <dt>Revision</dt>
                      <dd className="mt-1 font-mono text-foreground">
                        {release.revision}
                      </dd>
                    </div>
                    <div>
                      <dt>Catalog generation</dt>
                      <dd className="mt-1 font-mono text-foreground">
                        {diagnostics.data?.generation ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Catalog size</dt>
                      <dd className="mt-1 font-mono text-foreground">
                        {diagnostics.data
                          ? `${diagnostics.data.byte_size} bytes`
                          : "—"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt>Scope key</dt>
                      <dd className="mt-1 break-all font-mono text-foreground">
                        {release.scope_key}
                      </dd>
                    </div>
                  </dl>
                  {diagnostics.isError ? (
                    <p className="mt-3 text-destructive">
                      Diagnostics are unavailable. Bundle settings are
                      unaffected.
                    </p>
                  ) : null}
                </details>
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog onOpenChange={setConfirmDiscard} open={confirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your Bundle changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
              variant="destructive"
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove this Bundle from {channelName ?? "the channel"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The Bundle file stays available. This only removes it from the
              channel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!release) return;
                try {
                  await remove.mutateAsync({
                    expectedRevision: release.revision,
                    releaseId: release.id,
                  });
                  toast.success(
                    `Bundle removed from ${channelName ?? "the channel"}`,
                  );
                  setConfirmDelete(false);
                  onOpenChange(false);
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Bundle could not be removed from the channel.",
                  );
                }
              }}
              variant="destructive"
            >
              Remove from channel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog onOpenChange={handlePromoteOpenChange} open={showPromote}>
        <DialogContent showCloseButton={!promote.isPending}>
          <DialogHeader>
            <DialogTitle>Promote to Channel</DialogTitle>
            <DialogDescription>
              Choose how to promote this Bundle, then select the target channel.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="promote-action">Action</Label>
              <Select
                disabled={promote.isPending}
                items={promoteActionItems}
                onValueChange={(value) =>
                  setPromoteAction(value as "copy" | "move")
                }
                value={promoteAction}
              >
                <SelectTrigger className="w-full" id="promote-action">
                  <SelectValue placeholder="Select an action" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="move">Move bundle</SelectItem>
                    <SelectItem value="copy">Copy bundle</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {isCopyPromotion
                  ? "Make this Bundle available in the target channel and keep it in the current channel."
                  : "Move this Bundle to the target channel. Devices in the current channel may fall back to an earlier Bundle."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-channel">Target Channel</Label>
              <Select
                disabled={promote.isPending}
                items={availableChannelItems}
                onValueChange={(value) => setTargetChannel(value ?? "")}
                value={targetChannel || null}
              >
                <SelectTrigger className="w-full" id="target-channel">
                  <SelectValue placeholder="Select a channel" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectGroup>
                    {availableChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.name}>
                        {channel.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              disabled={promote.isPending}
              onClick={() => handlePromoteOpenChange(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!normalizedTargetChannel || promote.isPending}
              onClick={async () => {
                if (!release) return;
                try {
                  await promote.mutateAsync({
                    action: promoteAction,
                    expectedRevision: release.revision,
                    releaseId: release.id,
                    targetChannel: normalizedTargetChannel,
                  });
                  handlePromoteOpenChange(false);
                  toast.success(
                    isCopyPromotion
                      ? `Bundle copied to ${normalizedTargetChannel}`
                      : `Bundle moved to ${normalizedTargetChannel}`,
                    release.bundle_id
                      ? { description: `bundleId: ${release.bundle_id}` }
                      : undefined,
                  );
                } catch (caught) {
                  toast.error(
                    caught instanceof Error
                      ? caught.message
                      : "Bundle could not be promoted.",
                  );
                }
              }}
            >
              {promote.isPending
                ? isCopyPromotion
                  ? "Copying…"
                  : "Moving…"
                : isCopyPromotion
                  ? "Copy"
                  : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
