import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CircleCheck, History } from "lucide-react";

import { HashValueDisplay } from "@/components/HashValueDisplay";
import { TimestampDisplay } from "@/components/TimestampDisplay";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  nativeBuildArtifacts,
  nativeBuildTarget,
  platformLabel,
} from "@/lib/native-builds";
import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

import { CommitLink } from "./CommitLink";

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

/** Whether new deploys patch from this build, or from a newer one of its scope. */
function BaselineStatus({ detail }: { readonly detail: NativeBuildDetail }) {
  const { build, newestInScope } = detail;
  if (newestInScope === null) return null;
  if (newestInScope.id === build.id) {
    return (
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
        <CircleCheck
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <p>
          <span className="font-medium">Current baseline.</span> New deploys to
          this scope add a patch from this build's bundle.
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
      <History
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <p>
        <span className="font-medium">Superseded</span> by{" "}
        <Link
          className="inline-flex items-center gap-0.5 font-medium underline underline-offset-4"
          params={{ buildId: newestInScope.id }}
          to="/native-builds/$buildId"
        >
          {platformLabel(newestInScope.platform)}{" "}
          {nativeBuildArtifacts[newestInScope.artifact_kind].label} ·{" "}
          <TimestampDisplay uuid={newestInScope.id} />
          <ArrowUpRight aria-hidden="true" className="size-3" />
        </Link>
        . New deploys patch from that build, so this one gets no new patches.
      </p>
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
              <HashValueDisplay
                maxLength={target.label === "App version" ? 24 : 12}
                value={target.value}
              />
            </span>
          </Row>
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
