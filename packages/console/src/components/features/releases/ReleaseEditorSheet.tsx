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
import { AlertTriangle, Box, Download, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { normalizeRange } from "verkit";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { BundleAnalyticsSummary } from "@/components/features/bundles/BundleAnalyticsSummary";
import { BundleMetadata } from "@/components/features/bundles/BundleMetadata";
import { RolloutCohortsDialog } from "@/components/features/bundles/RolloutCohortsDialog";
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
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  useReleaseRollbackCandidatesQuery,
  useRollbackReleaseMutation,
  useUpdateReleaseMutation,
} from "@/lib/api";

import { ReleaseStateBadge } from "./ReleaseStateBadge";

interface Draft {
  enabled: boolean;
  message: string;
  rolloutCohortCount: number;
  shouldForceUpdate: boolean;
  targetAppVersion: string;
  targetCohorts: string[];
}

const promoteActionItems = [
  { label: "Keep source enabled", value: "copy" },
  { label: "Disable source after promoting", value: "move" },
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
  const rollback = useRollbackReleaseMutation();
  const rollbackCandidates = useReleaseRollbackCandidatesQuery(releaseId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newCohort, setNewCohort] = useState("");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [showRollback, setShowRollback] = useState(false);
  const [targetChannel, setTargetChannel] = useState("");
  const [promoteAction, setPromoteAction] = useState<"copy" | "move">("copy");
  const [rollbackTarget, setRollbackTarget] = useState("builtin");

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
    promote.isPending ||
    rollback.isPending;

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
  const availableChannelItems = [
    { label: "Select a channel", value: null },
    ...availableChannels.map((channel) => ({
      label: channel.name,
      value: channel.name,
    })),
  ];
  const rollbackItems = [
    { label: "Built-in app", value: "builtin" },
    ...(rollbackCandidates.data ?? []).map((candidate) => ({
      label: candidate.bundle_id
        ? `Bundle ${candidate.bundle_id.slice(0, 12)}…`
        : "Built-in app",
      value: candidate.id,
    })),
  ];

  return (
    <>
      <Sheet
        onOpenChange={(nextOpen) => (nextOpen ? undefined : requestClose())}
        open={open}
      >
        <SheetContent className="min-w-0 overflow-hidden data-[side=right]:w-full sm:max-w-[620px]">
          <SheetHeader className="shrink-0 border-b p-4 pr-12 sm:p-6 sm:pr-12">
            <SheetTitle>Bundle Detail</SheetTitle>
            <SheetDescription className="sr-only">
              Edit bundle delivery settings.
            </SheetDescription>
            {release ? (
              <div className="flex min-w-0 flex-col gap-2 pt-1 text-xs text-muted-foreground">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ReleaseStateBadge release={release} />
                  <Badge className="max-w-full" variant="outline">
                    <span className="truncate">{channelName}</span>
                  </Badge>
                  <Badge variant="outline">
                    {release.platform === "ios" ? "iOS" : "Android"}
                  </Badge>
                </div>
                <div
                  className="min-w-0 text-foreground"
                  title={release.bundle_id ?? undefined}
                >
                  {release.bundle_id ? (
                    <BundleIdDisplay
                      bundleId={release.bundle_id}
                      className="block truncate break-normal"
                    />
                  ) : (
                    <span className="inline-flex items-center gap-2 font-medium">
                      <Box className="size-4" /> Built-in app
                    </span>
                  )}
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
              <div className="flex flex-col gap-8 px-4 py-6 sm:px-6">
                {release.bundle_id ? (
                  <BundleAnalyticsSummary bundleId={release.bundle_id} />
                ) : null}
                {release.bundle_id && bundleQuery.isPending ? (
                  <Skeleton className="h-64 w-full" />
                ) : null}
                {release.bundle_id && bundleQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertTitle>
                      Bundle file details could not be loaded
                    </AlertTitle>
                    <AlertDescription>
                      Delivery settings are still available below.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <section className="flex flex-col gap-5">
                  <h3 className="text-sm font-semibold">Delivery</h3>
                  <FieldGroup className="gap-5">
                    <Field>
                      <FieldLabel htmlFor="release-message">Message</FieldLabel>
                      <Textarea
                        autoComplete="off"
                        id="release-message"
                        name="message"
                        onChange={(event) =>
                          setDraft({ ...draft, message: event.target.value })
                        }
                        rows={2}
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
                      </Field>
                    ) : null}
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="release-enabled">
                        Enabled for new installs
                      </FieldLabel>
                      <Switch
                        aria-label="Enabled for new installs"
                        checked={draft.enabled}
                        id="release-enabled"
                        name="enabled"
                        onCheckedChange={(enabled) =>
                          setDraft({ ...draft, enabled })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldTitle>Installed devices</FieldTitle>
                      <Button
                        className="w-full"
                        disabled={busy}
                        onClick={() => setShowRollback(true)}
                        size="lg"
                        type="button"
                        variant="outline"
                      >
                        Roll Back Installed Devices…
                      </Button>
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
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldLabel htmlFor="release-rollout-percentage">
                          Rollout percentage
                        </FieldLabel>
                        <RolloutCohortsDialog
                          releaseId={release.id}
                          rolloutCohortCount={draft.rolloutCohortCount}
                          targetCohorts={draft.targetCohorts}
                        />
                      </div>
                      <RolloutPercentageInput
                        onChange={(rolloutCohortCount) =>
                          setDraft({ ...draft, rolloutCohortCount })
                        }
                        value={draft.rolloutCohortCount}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="release-cohort">
                        Additional cohorts (optional)
                      </FieldLabel>
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
                            <Badge className="gap-1 font-mono" key={cohort}>
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

                <BundleMetadata bundle={bundle} release={release} />

                <section className="flex flex-col gap-4 border-t pt-8">
                  <h3 className="text-sm font-semibold">Actions</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      disabled={release.kind !== "BUNDLE" || busy}
                      onClick={() => setShowPromote(true)}
                      variant="outline"
                    >
                      Promote to Channel
                    </Button>
                    {release.bundle_id ? (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          window.open(
                            `/api/bundles/${encodeURIComponent(release.bundle_id!)}/download`,
                            "_blank",
                            "noopener,noreferrer",
                          );
                          toast.success("Bundle download started");
                        }}
                        variant="outline"
                      >
                        <Download data-icon="inline-start" />
                        Download Bundle
                      </Button>
                    ) : null}
                  </div>
                </section>

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
                      Catalog diagnostics could not be loaded.
                    </p>
                  ) : null}
                </details>

                <section className="flex flex-col gap-4 border-t pt-8">
                  <div>
                    <h3 className="text-sm font-semibold text-destructive">
                      Danger zone
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Disable before deleting.
                    </p>
                  </div>
                  <Button
                    disabled={release.enabled || busy}
                    onClick={() => setConfirmDelete(true)}
                    variant="destructive"
                  >
                    <Trash2 data-icon="inline-start" />
                    Delete Deployment
                  </Button>
                </section>
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
              Your edits to this bundle deployment will be lost.
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
              Delete this deployment permanently?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The Bundle file is not deleted. This only removes the deployment
              from the catalog and keeps a tombstone for clients.
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
                  toast.success("Deployment deleted");
                  setConfirmDelete(false);
                  onOpenChange(false);
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Deployment could not be deleted.",
                  );
                }
              }}
              variant="destructive"
            >
              Delete Deployment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog onOpenChange={setShowPromote} open={showPromote}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Promote to Channel</DialogTitle>
            <DialogDescription>
              Reuse this Bundle in another channel without copying its file.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Target channel</FieldLabel>
              <Select
                items={availableChannelItems}
                onValueChange={(value) => setTargetChannel(value ?? "")}
                value={targetChannel || null}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {availableChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.name}>
                        {channel.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Source deployment</FieldLabel>
              <Select
                items={promoteActionItems}
                onValueChange={(value) =>
                  setPromoteAction(value as "copy" | "move")
                }
                value={promoteAction}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="copy">Keep source enabled</SelectItem>
                    <SelectItem value="move">
                      Disable source after promoting
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={() => setShowPromote(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={!targetChannel || promote.isPending}
              onClick={async () => {
                if (!release) return;
                try {
                  await promote.mutateAsync({
                    action: promoteAction,
                    expectedRevision: release.revision,
                    releaseId: release.id,
                    targetChannel,
                  });
                  setShowPromote(false);
                  toast.success(`Bundle promoted to ${targetChannel}`);
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Bundle could not be promoted.",
                  );
                  setShowPromote(false);
                }
              }}
            >
              {promote.isPending ? "Promoting…" : "Promote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setShowRollback} open={showRollback}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roll Back Installed Devices</DialogTitle>
            <DialogDescription>
              Move installed devices to a previous Bundle or the built-in app.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="rollback-target">Move devices to</FieldLabel>
            <Select
              items={rollbackItems}
              onValueChange={(value) => setRollbackTarget(value ?? "builtin")}
              value={rollbackTarget}
            >
              <SelectTrigger id="rollback-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="builtin">Built-in app</SelectItem>
                  {(rollbackCandidates.data ?? []).map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.bundle_id
                        ? `Bundle ${candidate.bundle_id.slice(0, 12)}…`
                        : "Built-in app"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button onClick={() => setShowRollback(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={rollback.isPending}
              onClick={async () => {
                if (!release) return;
                try {
                  await rollback.mutateAsync({
                    expectedRevision: release.revision,
                    releaseId: release.id,
                    ...(rollbackTarget === "builtin"
                      ? { toBundleId: null }
                      : { toReleaseId: rollbackTarget }),
                  });
                  setShowRollback(false);
                  toast.success("Rollback created");
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Rollback could not be created.",
                  );
                  setShowRollback(false);
                }
              }}
            >
              {rollback.isPending ? "Rolling back…" : "Roll Back Devices"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
