import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { shortenIdentifier } from "@/components/HashValueDisplay";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useReleaseNativeBuildQuery } from "@/lib/api";
import {
  nativeBuildArtifacts,
  platformLabel,
  releaseNativeBuildScope,
} from "@/lib/native-builds";

/**
 * The native build a release's bundle reaches, and whether that bundle has
 * a patch from its built-in bundle: the newest build of the release's
 * scope, one read. A release of an app version range targets many builds,
 * so it shows none and reads nothing.
 */
export function ReleaseNativeBuildLink({
  release,
  channel,
  bundle,
}: {
  readonly release: Pick<
    ReleaseRow,
    "platform" | "fingerprint_hash" | "target_app_version" | "bundle_id"
  >;
  readonly channel: string;
  /** The release's bundle with its patches, once loaded. */
  readonly bundle: Pick<Bundle, "patches"> | null | undefined;
}) {
  const input =
    release.bundle_id === null
      ? null
      : {
          platform: release.platform,
          channel,
          fingerprintHash: release.fingerprint_hash,
          targetAppVersion: release.target_app_version,
        };
  const scoped = input !== null && releaseNativeBuildScope(input) !== null;
  const query = useReleaseNativeBuildQuery(scoped ? input : null);
  if (!scoped) return null;

  const build = query.data;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-muted-foreground">Native build</span>
      {query.isPending ? (
        <Skeleton className="h-4 w-40" />
      ) : build ? (
        <>
          <Link
            className="inline-flex items-center gap-0.5 text-xs text-foreground underline-offset-4 hover:underline"
            params={{ buildId: build.id }}
            to="/native-builds/$buildId"
          >
            {platformLabel(build.platform)}{" "}
            {nativeBuildArtifacts[build.artifact_kind].label} ·{" "}
            <span className="font-mono" translate="no">
              {shortenIdentifier(build.min_bundle_id, 20)}
            </span>
            <ArrowUpRight aria-hidden="true" className="size-3" />
          </Link>
          {bundle ? (
            <Badge variant="secondary">
              {(bundle.patches ?? []).some(
                ({ baseBundleId }) => baseBundleId === build.min_bundle_id,
              )
                ? "Patches from it"
                : "No patch from it"}
            </Badge>
          ) : null}
        </>
      ) : query.isError ? (
        <span className="text-xs text-muted-foreground">
          Couldn't load the scope's native build.{" "}
          <button
            className="underline underline-offset-4"
            onClick={() => void query.refetch()}
            type="button"
          >
            Retry
          </button>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          None tracked for this scope ·{" "}
          <Link
            className="underline-offset-4 hover:text-foreground hover:underline"
            search={{ channel }}
            to="/native-builds"
          >
            This channel's builds
          </Link>
        </span>
      )}
    </div>
  );
}
