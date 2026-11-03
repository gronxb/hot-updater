import { Fingerprint, KeyRound, type LucideIcon, Package } from "lucide-react";

import { HashValueDisplay } from "./HashValueDisplay";

/** A hash behind its icon, shortened to `xxxxxxxx…xxxx` and copied on click. */
function IconHash({
  icon: Icon,
  value,
  display,
}: {
  readonly icon: LucideIcon;
  readonly value: string;
  readonly display?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <HashValueDisplay display={display} maxLength={12} value={value} />
    </span>
  );
}

/** The cell of a missing value, such as an imported build's build key. */
export function NoValue() {
  return <span className="text-muted-foreground">-</span>;
}

/**
 * What OTAs target: an app version, or a fingerprint. The Bundles table's
 * Target column and a native build's show one release's target the same way,
 * so the two compare at a glance.
 */
export function TargetDisplay({
  appVersion,
  fingerprintHash,
}: {
  readonly appVersion: string | null;
  readonly fingerprintHash: string | null;
}) {
  if (appVersion) {
    return (
      <span className="flex items-center gap-2">
        <Package className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{appVersion}</span>
      </span>
    );
  }
  if (fingerprintHash) {
    return <IconHash icon={Fingerprint} value={fingerprintHash} />;
  }
  return <NoValue />;
}

/**
 * A native build's build key, `nbk1:` and a SHA-256 of the build's inputs,
 * shown past its prefix as a fingerprint is, and copied whole; none for an
 * imported build.
 */
export function BuildKeyDisplay({ value }: { readonly value: string | null }) {
  return value ? (
    <IconHash
      display={value.replace(/^nbk1:/, "")}
      icon={KeyRound}
      value={value}
    />
  ) : (
    <NoValue />
  );
}
