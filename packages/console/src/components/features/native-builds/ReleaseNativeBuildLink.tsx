import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { BuiltinBundleDisplay } from "@/components/BuiltinBundleDisplay";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ReleaseNativeBuildInput,
  useReleaseNativeBuildQuery,
} from "@/lib/api";
import {
  builtinBundleVersion,
  nativeBuildArtifacts,
  platformLabel,
  releaseNativeBuildScope,
} from "@/lib/native-builds";

type LinkedRelease = Pick<
  ReleaseRow,
  "platform" | "fingerprint_hash" | "target_app_version" | "bundle_id"
>;

/**
 * The read of a release's scope build, or null when it reads nothing: a
 * release of the built-in bundle, or of an app version range, which targets
 * many builds. The release sheet's patch base row takes the same read, so
 * the two share one request.
 */
export const releaseNativeBuildInput = (
  release: LinkedRelease,
  channel: string,
): ReleaseNativeBuildInput | null => {
  if (release.bundle_id === null) return null;
  const input = {
    platform: release.platform,
    channel,
    fingerprintHash: release.fingerprint_hash,
    targetAppVersion: release.target_app_version,
  };
  return releaseNativeBuildScope(input) === null ? null : input;
};

/**
 * The native build new deploys to a release's scope patch from, and whether
 * this bundle has a patch from its built-in bundle: the scope's store build,
 * or with none its newest, in two reads at most. A release of an app version
 * range targets many builds, so it shows none and reads nothing.
 */
export function ReleaseNativeBuildLink({
  release,
  channel,
  bundle,
}: {
  readonly release: LinkedRelease;
  readonly channel: string;
  /** The release's bundle with its patches, once loaded. */
  readonly bundle: Pick<Bundle, "patches"> | null | undefined;
}) {
  const input = releaseNativeBuildInput(release, channel);
  const query = useReleaseNativeBuildQuery(input);
  if (input === null) return null;

  const build = query.data;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-muted-foreground">Native build</span>
      {query.isPending ? (
        <Skeleton className="h-4 w-40" />
      ) : build ? (
        <>
          <Link
            className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-foreground underline-offset-4 hover:underline"
            params={{ buildId: build.id }}
            to="/native-builds/$buildId"
          >
            {platformLabel(build.platform)}{" "}
            {nativeBuildArtifacts[build.artifact_kind].label} ·{" "}
            {/* Inside the link, so the name is text, not a copy button. */}
            <BuiltinBundleDisplay
              appVersion={builtinBundleVersion(build)}
              bundleId={build.min_bundle_id}
              copyable={false}
            />
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
            className="relative underline-offset-4 after:absolute after:-inset-x-2 after:-inset-y-4 hover:text-foreground hover:underline md:after:hidden"
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
