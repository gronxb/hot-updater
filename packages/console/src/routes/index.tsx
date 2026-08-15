import type { ReleasePolicyPatch, ReleaseRow } from "@hot-updater/plugin-core";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CircleOff,
  Gauge,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useChannelsQuery,
  useDeleteReleaseMutation,
  usePreflightReleaseMutation,
  useReleaseCatalogDiagnosticsQuery,
  useReleaseQuery,
  useReleasesQuery,
  useUpdateReleaseMutation,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: ReleasesPage });

type Draft = {
  enabled: boolean;
  message: string;
  rolloutCohortCount: string;
  shouldForceUpdate: boolean;
  targetAppVersion: string;
  targetCohorts: string;
};

const draftFromRelease = (release: ReleaseRow): Draft => ({
  enabled: release.enabled,
  message: release.message ?? "",
  rolloutCohortCount: String(release.rollout_cohort_count),
  shouldForceUpdate: release.should_force_update,
  targetAppVersion: release.target_app_version ?? "",
  targetCohorts: release.target_cohorts.join(", "),
});

const patchFromDraft = (
  release: ReleaseRow,
  draft: Draft,
): ReleasePolicyPatch => ({
  enabled: draft.enabled,
  message: draft.message.trim() || null,
  rolloutCohortCount: Number(draft.rolloutCohortCount),
  shouldForceUpdate: draft.shouldForceUpdate,
  ...(release.strategy === "APP_VERSION"
    ? { targetAppVersion: draft.targetAppVersion.trim() }
    : {}),
  targetCohorts: draft.targetCohorts
    .split(",")
    .map((cohort) => cohort.trim())
    .filter(Boolean),
});

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

function ReleaseState({ release }: { release: ReleaseRow }) {
  return (
    <Badge
      className={cn(
        "gap-1 border-0",
        release.enabled
          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
      variant="secondary"
    >
      {release.enabled ? (
        <Check className="size-3" />
      ) : (
        <CircleOff className="size-3" />
      )}
      {release.enabled ? "Enabled" : "Disabled"}
    </Badge>
  );
}

function ReleasesPage() {
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const { data: releases = [], isLoading } = useReleasesQuery({ limit: 100 });
  const { data: channels = [] } = useChannelsQuery();
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );

  return (
    <div className="flex h-svh min-h-0 flex-col bg-muted/5">
      <header className="border-b bg-background px-4 py-4 sm:px-6">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <Gauge className="size-3.5" /> Delivery control plane
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Releases</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Mutable delivery policy, ordered independently from immutable
              Bundle artifacts.
            </p>
          </div>
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border bg-card text-xs shadow-sm">
            <div className="border-r px-4 py-3">
              <div className="text-muted-foreground">Visible</div>
              <div className="mt-1 text-lg font-semibold">
                {releases.length}
              </div>
            </div>
            <div className="border-r px-4 py-3">
              <div className="text-muted-foreground">Enabled</div>
              <div className="mt-1 text-lg font-semibold text-emerald-600">
                {releases.filter((release) => release.enabled).length}
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-muted-foreground">Embedded</div>
              <div className="mt-1 text-lg font-semibold">
                {
                  releases.filter((release) => release.kind === "EMBEDDED")
                    .length
                }
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 p-3 sm:p-6">
        <div className="h-full overflow-auto rounded-lg border bg-card shadow-sm [content-visibility:auto]">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <TableRow>
                <TableHead>Release</TableHead>
                <TableHead>Bundle / Embedded</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rollout</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading
                ? Array.from({ length: 7 }, (_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={9}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : releases.map((release) => (
                    <TableRow
                      className="cursor-pointer transition-colors hover:bg-muted/45"
                      key={release.id}
                      onClick={() => setSelectedReleaseId(release.id)}
                    >
                      <TableCell>
                        <div
                          className="font-mono text-xs font-medium"
                          title={release.id}
                        >
                          {shortId(release.id)}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          rev {release.revision}
                        </div>
                      </TableCell>
                      <TableCell>
                        {release.bundle_id === null ? (
                          <span className="inline-flex items-center gap-1.5 text-sm">
                            <RotateCcw className="size-3.5 text-amber-600" />{" "}
                            Embedded
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 font-mono text-xs"
                            title={release.bundle_id}
                          >
                            <Box className="size-3.5 text-muted-foreground" />{" "}
                            {shortId(release.bundle_id)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {channelNames.get(release.channel_id) ??
                          release.channel_id}
                      </TableCell>
                      <TableCell className="capitalize">
                        {release.platform}
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-xs">
                        {release.target_app_version ?? release.fingerprint_hash}
                      </TableCell>
                      <TableCell>
                        <ReleaseState release={release} />
                      </TableCell>
                      <TableCell>
                        {release.rollout_cohort_count / 10}%
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{release.operation}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(release.created_at_ms).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
              {!isLoading && releases.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="h-40 text-center text-muted-foreground"
                    colSpan={9}
                  >
                    No Releases yet. A deploy creates one Release per platform.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </main>

      <ReleaseEditor
        channelName={
          releases.find((release) => release.id === selectedReleaseId)
            ? channelNames.get(
                releases.find((release) => release.id === selectedReleaseId)!
                  .channel_id,
              )
            : undefined
        }
        onOpenChange={(open) => !open && setSelectedReleaseId("")}
        open={selectedReleaseId.length > 0}
        releaseId={selectedReleaseId}
      />
    </div>
  );
}

function ReleaseEditor({
  channelName,
  onOpenChange,
  open,
  releaseId,
}: {
  channelName?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  releaseId: string;
}) {
  const { data: release } = useReleaseQuery(releaseId);
  const diagnostics = useReleaseCatalogDiagnosticsQuery(
    release?.scope_key ?? "",
  );
  const update = useUpdateReleaseMutation();
  const preflight = usePreflightReleaseMutation();
  const remove = useDeleteReleaseMutation();
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    setDraft(release ? draftFromRelease(release) : null);
  }, [release]);

  const save = async () => {
    if (!release || !draft) return;
    const rollout = Number(draft.rolloutCohortCount);
    if (!Number.isInteger(rollout) || rollout < 0 || rollout > 1000) {
      toast.error("Rollout must be an integer from 0 to 1000.");
      return;
    }
    const input = {
      expectedRevision: release.revision,
      patch: patchFromDraft(release, draft),
      releaseId: release.id,
    };
    await preflight.mutateAsync(input);
    await update.mutateAsync(input);
    toast.success("Release policy and catalog committed atomically.");
  };

  const hardDelete = async () => {
    if (!release || release.enabled) return;
    if (!window.confirm(`Permanently delete disabled Release ${release.id}?`))
      return;
    await remove.mutateAsync({
      expectedRevision: release.revision,
      releaseId: release.id,
    });
    toast.success("Release deleted; catalog tombstone generation retained.");
    onOpenChange(false);
  };

  const projected = preflight.data;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[620px]">
        <SheetHeader className="border-b pb-5">
          <SheetTitle>Release policy</SheetTitle>
          {release ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="font-mono text-foreground">{release.id}</div>
              <div className="flex flex-wrap items-center gap-2">
                <ReleaseState release={release} />
                <Badge variant="outline">revision {release.revision}</Badge>
                <Badge variant="outline">
                  {channelName ?? release.channel_id}
                </Badge>
                <Badge variant="outline">{release.platform}</Badge>
              </div>
            </div>
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
        </SheetHeader>

        {release && draft ? (
          <div className="space-y-6 px-4 pb-6 sm:px-6">
            <section className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-4 text-xs">
              <div>
                <div className="text-muted-foreground">Bundle</div>
                <div className="mt-1 font-mono">
                  {release.bundle_id ?? "EMBEDDED"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Operation</div>
                <div className="mt-1">{release.operation}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Generation</div>
                <div className="mt-1">
                  {diagnostics.data?.generation ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Catalog bytes</div>
                <div className="mt-1">
                  {diagnostics.data?.byte_size ?? "—"} / 262144
                </div>
              </div>
              <div className="col-span-2">
                <div className="text-muted-foreground">Scope</div>
                <div className="mt-1 break-all font-mono">
                  {release.scope_key}
                </div>
              </div>
            </section>

            <div className="grid gap-5">
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label htmlFor="release-enabled">Enabled</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Disabling can converge active clients to an older Release or
                    local BUILTIN.
                  </p>
                </div>
                <Switch
                  checked={draft.enabled}
                  id="release-enabled"
                  onCheckedChange={(enabled) =>
                    setDraft((current) => current && { ...current, enabled })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label htmlFor="release-force">Force update</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Same-Bundle adoption changes metadata only and does not
                    reload.
                  </p>
                </div>
                <Switch
                  checked={draft.shouldForceUpdate}
                  id="release-force"
                  onCheckedChange={(shouldForceUpdate) =>
                    setDraft(
                      (current) => current && { ...current, shouldForceUpdate },
                    )
                  }
                />
              </div>
              {release.strategy === "APP_VERSION" ? (
                <div className="space-y-2">
                  <Label htmlFor="release-target">App-version target</Label>
                  <Input
                    id="release-target"
                    value={draft.targetAppVersion}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        targetAppVersion: event.target.value,
                      })
                    }
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Fingerprint target</Label>
                  <Input disabled value={release.fingerprint_hash ?? ""} />
                  <p className="text-xs text-muted-foreground">
                    Fingerprint identity is part of the catalog scope and cannot
                    be moved by this editor.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="release-rollout">Rollout cohort count</Label>
                <Input
                  id="release-rollout"
                  inputMode="numeric"
                  max={1000}
                  min={0}
                  type="number"
                  value={draft.rolloutCohortCount}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      rolloutCohortCount: event.target.value,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Reducing rollout may move excluded active clients to a prior
                  Release or BUILTIN.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="release-cohorts">Target cohorts</Label>
                <Input
                  id="release-cohorts"
                  placeholder="qa, dogfood"
                  value={draft.targetCohorts}
                  onChange={(event) =>
                    setDraft({ ...draft, targetCohorts: event.target.value })
                  }
                />
                <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Cohort names are shipped in the public device catalog. Use
                  opaque buckets, never identities or secrets.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="release-message">Message</Label>
                <Textarea
                  id="release-message"
                  value={draft.message}
                  onChange={(event) =>
                    setDraft({ ...draft, message: event.target.value })
                  }
                />
              </div>
            </div>

            {projected ? (
              <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs">
                <div className="mb-3 flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                  <Check className="size-4" /> Compiler preflight passed
                </div>
                <div className="grid grid-cols-3 gap-3 text-muted-foreground">
                  <div>
                    <span className="block text-foreground">
                      {projected.diagnostics.byteSize}
                    </span>
                    projected bytes
                  </div>
                  <div>
                    <span className="block text-foreground">
                      {projected.diagnostics.descriptorCount}
                    </span>
                    descriptors
                  </div>
                  <div>
                    <span className="block text-foreground">
                      {projected.catalog.generation}
                    </span>
                    next generation
                  </div>
                </div>
              </section>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <Button
                disabled={release.enabled || remove.isPending}
                onClick={hardDelete}
                size="sm"
                variant="destructive"
              >
                <Trash2 className="size-4" /> Hard delete
              </Button>
              <div className="flex gap-2">
                <Button
                  disabled={preflight.isPending || update.isPending}
                  onClick={() =>
                    preflight.mutate({
                      expectedRevision: release.revision,
                      patch: patchFromDraft(release, draft),
                      releaseId: release.id,
                    })
                  }
                  variant="outline"
                >
                  <Gauge className="size-4" /> Preflight
                </Button>
                <Button
                  disabled={preflight.isPending || update.isPending}
                  onClick={save}
                >
                  <ArrowRight className="size-4" /> Save atomically
                </Button>
              </div>
            </div>
            {release.enabled ? (
              <p className="text-xs text-muted-foreground">
                Disable this Release before hard deletion. Bundle deletion
                remains blocked while any Release or patch references it.
              </p>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
