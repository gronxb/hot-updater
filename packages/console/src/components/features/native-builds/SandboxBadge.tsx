import type { NativeBuildRow } from "@hot-updater/plugin-core";

import { Badge } from "@/components/ui/badge";

/**
 * "Sandbox" on a sandbox build, as the registry records it, whatever its
 * channel; nothing on any other. It badges the build as "Store build" does.
 */
export function SandboxBadge({
  build,
}: {
  readonly build: Pick<NativeBuildRow, "is_sandbox">;
}) {
  return build.is_sandbox ? <Badge variant="secondary">Sandbox</Badge> : null;
}
