import { cn } from "@/lib/utils";

import { CopyableIdTail, IdTailText } from "./IdTail";

/**
 * How the Console names a built-in bundle: "Built-in bundle", then the app
 * version where the surface has one, such as `Built-in bundle · 1.6.1 (63)`.
 * Its ID is the native build's time with zero random bits, so no piece of it
 * tells one build's bundle from another's.
 */
export const builtinBundleName = (appVersion?: string | null) =>
  appVersion ? `Built-in bundle · ${appVersion}` : "Built-in bundle";

/**
 * A built-in bundle by its name instead of its ID: hovering, focusing, or
 * tapping it shows the full ID in a popover titled "Built-in bundle ID", and
 * a click copies it, as an ID tail does.
 */
export function BuiltinBundleDisplay({
  bundleId,
  appVersion,
  copyable = true,
  className,
}: {
  /** The built-in bundle's ID: a native build's `min_bundle_id`. */
  readonly bundleId: string;
  /**
   * The version the surface already has for it: a native build's store
   * label (`1.6.1 (63)`), or the app version a report or a row names. Left
   * out, it reads "Built-in bundle" alone.
   */
  readonly appVersion?: string | null;
  /**
   * Whether it is a copy button. Turn it off inside another control that
   * can't hold a button, such as a link: the full ID then shows on hover
   * from `title`.
   */
  readonly copyable?: boolean;
  readonly className?: string;
}) {
  const name = builtinBundleName(appVersion);
  return copyable ? (
    <span className="inline-flex whitespace-nowrap">
      <CopyableIdTail
        id={bundleId}
        kind="builtin"
        name={name}
        // A value among values, as an artifact ID is: its size and color.
        // Its 16 px line reaches 44 px tall on a phone; a caller that sets
        // another size sets the reach that keeps it 44 px.
        className={cn("text-xs text-foreground after:-inset-y-3.5", className)}
      />
    </span>
  ) : (
    <IdTailText
      id={bundleId}
      name={name}
      className={cn("text-xs text-foreground", className)}
    />
  );
}
