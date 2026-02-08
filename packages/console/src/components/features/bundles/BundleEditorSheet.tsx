import type { Bundle } from "@hot-updater/plugin-core";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { BundleBasicInfo } from "./BundleBasicInfo";
import { BundleEditorForm } from "./BundleEditorForm";
import { BundleMetadata } from "./BundleMetadata";
import { LazyRolloutStatsCard } from "./LazyRolloutStatsCard";

interface BundleEditorSheetProps {
  bundle: Bundle | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BundleEditorSheet({
  bundle,
  open,
  onOpenChange,
}: BundleEditorSheetProps) {
  if (!bundle) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:max-w-[600px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit Bundle</SheetTitle>
          <SheetDescription>
            <BundleBasicInfo bundle={bundle} />
          </SheetDescription>
        </SheetHeader>

        <div className="px-6 pb-6 space-y-6">
          <LazyRolloutStatsCard bundleId={bundle.id} />
          <BundleEditorForm
            bundle={bundle}
            onClose={() => onOpenChange(false)}
          />
          <BundleMetadata bundle={bundle} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
