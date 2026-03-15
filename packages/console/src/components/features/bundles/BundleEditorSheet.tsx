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
  if (!open) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:max-w-[600px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{bundle ? "Edit Bundle" : "Bundle Details"}</SheetTitle>
          <SheetDescription>
            {bundle ? (
              <BundleBasicInfo bundle={bundle} />
            ) : loading ? (
              bundleId ? (
                <span className="font-mono text-xs">Loading {bundleId}</span>
              ) : (
                "Loading bundle details"
              )
            ) : bundleId ? (
              <span className="font-mono text-xs">
                Bundle not found: {bundleId}
              </span>
            ) : (
              "Bundle details unavailable"
            )}
          </SheetDescription>
        </SheetHeader>

        {bundle ? (
          <div className="px-6 pb-6 space-y-6">
            <BundleEditorForm
              key={bundle.id}
              bundle={bundle}
              onClose={() => onOpenChange(false)}
            />
            <BundleMetadata bundle={bundle} />
          </div>
        ) : loading ? (
          <div className="px-6 pb-6 space-y-4">
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
