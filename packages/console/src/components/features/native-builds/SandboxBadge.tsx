import type { NativeBuildRow } from "@hot-updater/plugin-core";

import { Badge } from "@/components/ui/badge";

/**
 * "Sandbox" on a sandbox build, as the registry records it, whatever its
 * channel; nothing on any other. A qualifier of the artifact kind beside it,
 * so a quiet tag: tinted and muted like a neutral channel, the row's chip
 * height, and narrow, as "Store build" is.
 */
export function SandboxBadge({
  build,
}: {
  readonly build: Pick<NativeBuildRow, "is_sandbox">;
}) {
  return build.is_sandbox ? (
    <Badge className="px-1.5" variant="muted">
      Sandbox
    </Badge>
  ) : null;
}
