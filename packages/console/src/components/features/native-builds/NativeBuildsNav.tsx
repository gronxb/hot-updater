import { Link } from "@tanstack/react-router";

import { tabsListVariants } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const TAB_CLASS =
  "relative inline-flex h-full items-center justify-center rounded-md border border-transparent px-3 text-xs font-medium whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:aria-[current=page]:border-input dark:aria-[current=page]:bg-input/30 dark:aria-[current=page]:text-foreground";

/**
 * The two views of Native builds: the builds, and the iOS devices ad hoc
 * builds install on. Links, so each view has its own URL and Back works.
 */
export function NativeBuildsNav({
  current,
}: {
  readonly current: "builds" | "devices";
}) {
  return (
    <nav
      aria-label="Native builds views"
      className={cn(
        tabsListVariants(),
        "h-11 sm:h-8 [&>a]:min-h-10 sm:[&>a]:min-h-0",
      )}
    >
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        aria-current={current === "builds" ? "page" : undefined}
        className={TAB_CLASS}
        to="/native-builds"
      >
        Builds
      </Link>
      <Link
        activeOptions={{ exact: true, includeSearch: false }}
        aria-current={current === "devices" ? "page" : undefined}
        className={TAB_CLASS}
        to="/native-builds/devices"
      >
        iOS devices
      </Link>
    </nav>
  );
}
