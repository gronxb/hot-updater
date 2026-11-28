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

/** An app version behind its icon, as the Target column shows one. */
function AppVersion({ value }: { readonly value: string }) {
  return (
    <span className="flex items-center gap-2">
      <Package className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">{value}</span>
    </span>
  );
}

/**
 * What OTAs target: an app version, or a fingerprint. The Bundles table's
 * Target column and a native build's show one release's target the same way,
 * so the two compare at a glance. A native build also passes
 * `nativeAppVersion`, the app version its artifact reports: a fingerprint
 * build shows it over its fingerprint, so every build names its version in
 * the column's width. Without one, as on a build registered before it was
 * recorded, the fingerprint shows alone.
 */
export function TargetDisplay({
  appVersion,
  fingerprintHash,
  nativeAppVersion,
}: {
  readonly appVersion: string | null;
  readonly fingerprintHash: string | null;
  readonly nativeAppVersion?: string | null;
}) {
  if (appVersion) {
    return <AppVersion value={appVersion} />;
  }
  if (fingerprintHash) {
    const hash = <IconHash icon={Fingerprint} value={fingerprintHash} />;
    if (!nativeAppVersion) return hash;
    return (
      <span
        className="flex flex-col items-start gap-3 sm:gap-1"
        data-target-display=""
      >
        {/* The build's own version, which OTAs don't target: named so. On
            a phone, the gap clears the fingerprint's 44 px hit area. */}
        <span title="The app version this build reports">
          <span className="sr-only">App version </span>
          <AppVersion value={nativeAppVersion} />
        </span>
        {hash}
      </span>
    );
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
