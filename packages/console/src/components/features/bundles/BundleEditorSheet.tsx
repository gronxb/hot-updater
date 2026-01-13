import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Bundle } from "@hot-updater/plugin-core";
import { BundleEditorForm } from "./BundleEditorForm";
import { BundleMetadata } from "./BundleMetadata";
import { RolloutStatsCard } from "./RolloutStatsCard";

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
            Update bundle configuration and deployment settings
          </SheetDescription>
        </SheetHeader>

        <div className="px-6 pb-6 space-y-6">
          <RolloutStatsCard bundleId={bundle.id} />
          <BundleMetadata bundle={bundle} />
          <BundleEditorForm
            bundle={bundle}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
