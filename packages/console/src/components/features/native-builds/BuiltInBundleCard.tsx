import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleCheck, History } from "lucide-react";
import { toast } from "sonner";

import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMarkNativeBuildMutation } from "@/lib/api";
import {
  nativeBuildArtifacts,
  nativeBuildLabel,
  nativeBuildTarget,
  platformLabel,
} from "@/lib/native-builds";
import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

import { CommitLink } from "./CommitLink";
import { ShortHash } from "./ShortHash";
import { isSubmitted, StoreSubmissionBadge } from "./StoreSubmission";

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** Marks or clears the build where the card says what the mark does. */
function StoreBuildAction({ detail }: { readonly detail: NativeBuildDetail }) {
  const { build, channel } = detail;
  const mark = useMarkNativeBuildMutation();
  // No store sells a sandbox channel's build, so core refuses the mark.
  if (channel.startsWith("sandbox-")) return null;
  const storeBuild = build.store_build !== true;
  return (
    <Button
      className="min-h-11 shrink-0 sm:min-h-8"
      disabled={mark.isPending}
      onClick={() =>
        mark.mutate(
          { id: build.id, storeBuild },
          {
            onSuccess: () => {
              toast.success(
                storeBuild ? "Marked as the store build" : "Mark cleared",
              );
            },
            onError: (error) => {
              toast.error("Could not change the mark", {
                description: error.message,
              });
            },
          },
        )
      }
      size="sm"
      type="button"
      variant="outline"
    >
      {storeBuild ? "Mark as store build" : "Clear mark"}
    </Button>
  );
}

/**
 * Which build new deploys patch from: this one, as the store build or as the
 * newest with no mark, or another, which it links to.
 */
function BaselineStatus({ detail }: { readonly detail: NativeBuildDetail }) {
  const { build, newestInScope, storeBuildInScope } = detail;
  const base = storeBuildInScope ?? newestInScope;
  if (base === null) return null;
  const isBase = base.id === build.id;
  const Icon = isBase ? CircleCheck : History;
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/40 p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        {storeBuildInScope?.id === build.id ? (
          <p>
            <span className="font-medium">Store build.</span> New deploys to
            this scope patch from this build.
          </p>
        ) : isBase ? (
          <p>
            <span className="font-medium">Current baseline.</span> The newest
            build, and no store build is marked. New deploys to this scope patch
            from this build.
          </p>
        ) : (
          <p>
            <span className="font-medium">Not the base.</span> New deploys patch
            from{" "}
            <Link
              className="inline-flex items-center gap-0.5 font-medium underline underline-offset-4"
              params={{ buildId: base.id }}
              to="/native-builds/$buildId"
            >
              {nativeBuildLabel(base) ?? (
                <>
                  {platformLabel(base.platform)}{" "}
                  {nativeBuildArtifacts[base.artifact_kind].label} ·{" "}
                  <TimestampDisplay uuid={base.id} />
                </>
              )}
              <ArrowUpRight aria-hidden="true" className="size-3" />
            </Link>
            , so this one gets no new patches.
          </p>
        )}
      </div>
      <StoreBuildAction detail={detail} />
    </div>
  );
}

/**
 * The build's built-in bundle: the bundle every install runs until its
 * first OTA, and the base that OTA's patch starts from.
 */
export function BuiltInBundleCard({
  detail,
}: {
  readonly detail: NativeBuildDetail;
}) {
  const { build, builtInBundle, channel } = detail;
  const target = nativeBuildTarget(build);
  const childCount = builtInBundle?.childCount ?? 0;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Built-in bundle</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
        <dl className="flex flex-col gap-3">
          <Row label="Bundle ID">
            <span className="break-all font-mono text-xs" translate="no">
              {build.min_bundle_id}
            </span>
          </Row>
          <Row label="OTAs patching from it">
            <span className="tabular-nums">
              {childCount === 1 ? "1 bundle" : `${childCount} bundles`}
            </span>
          </Row>
          <Row label="Scope">
            <span className="flex flex-wrap items-center gap-1.5">
              <Link
                aria-label={`Show the builds that embed ${channel}`}
                search={{ channel }}
                to="/native-builds"
              >
                <Badge translate="no" variant="outline">
                  {channel}
                </Badge>
              </Link>
              <span className="text-xs">{platformLabel(build.platform)}</span>
              <span className="text-xs text-muted-foreground">
                · {target.label}
              </span>
              {build.fingerprint_hash === null ? (
                <span className="font-mono text-xs" translate="no">
                  {target.value}
                </span>
              ) : (
                <ShortHash
                  label="fingerprint"
                  length={12}
                  value={build.fingerprint_hash}
                />
              )}
            </span>
          </Row>
          {!build.build_number ? null : (
            <Row label="Build number">
              <span className="font-mono text-xs tabular-nums" translate="no">
                {build.build_number}
              </span>
            </Row>
          )}
          {isSubmitted(build) ? (
            <Row label="Store">
              <StoreSubmissionBadge build={build} withTime />
            </Row>
          ) : null}
          <Row label="Commit">
            <CommitLink hash={build.git_commit_hash} />
          </Row>
          <Row label="Created">
            <TimestampDisplay format="both" uuid={build.id} />
          </Row>
        </dl>
        <BaselineStatus detail={detail} />
        <p className="text-xs text-muted-foreground">
          A store or test install of this build runs this bundle until its first
          OTA. That OTA downloads as a patch from this bundle when one exists,
          and as the full bundle otherwise.
        </p>
      </CardContent>
    </Card>
  );
}
