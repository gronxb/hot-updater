import type { Bundle } from "@hot-updater/plugin-core";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import { BundleBasicInfo } from "./BundleBasicInfo";
import { BundleEditorForm } from "./BundleEditorForm";
import { BundleMetadata } from "./BundleMetadata";

interface BundleEditorSheetProps {
  bundleId?: string;
  bundle: Bundle | null;
  loading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BundleEditorSheet({
  bundleId,
  bundle,
  loading = false,
  open,
  onOpenChange,
}: BundleEditorSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[640px] overflow-y-auto overscroll-contain sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{bundle ? "Bundle Detail" : "Bundle Details"}</SheetTitle>
          <SheetDescription>
            {bundle ? (
              <BundleBasicInfo bundle={bundle} />
            ) : loading ? (
              bundleId ? (
                <span translate="no" className="font-mono text-xs">
                  Loading {bundleId}…
                </span>
              ) : (
                "Loading bundle details…"
              )
            ) : bundleId ? (
              <span translate="no" className="font-mono text-xs">
                Bundle not found: {bundleId}
              </span>
            ) : (
              "Bundle details unavailable"
            )}
          </SheetDescription>
        </SheetHeader>

        {bundle ? (
          <div className="flex flex-col gap-6 px-6 pb-6">
            <BundleEditorForm
              key={bundle.id}
              bundle={bundle}
              onClose={() => onOpenChange(false)}
            />
            <BundleMetadata bundle={bundle} />
          </div>
        ) : loading ? (
          <div className="flex flex-col gap-4 px-6 pb-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            The requested bundle could not be loaded.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
