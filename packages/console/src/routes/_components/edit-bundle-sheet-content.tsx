import { Show } from "solid-js";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleQuery } from "@/lib/api";
import { DeleteBundleDialog } from "./delete-bundle-dialog";
import { EditBundleSheetForm } from "./edit-bundle-sheet-form";
import { EmergencyRollbackButton } from "./emergency-rollback-button";
import { PromoteChannelDialog } from "./promote-channel-dialog";
import { RolloutStatsDialog } from "./rollout-stats-dialog";

export interface EditBundleSheetContentProps {
  bundleId: string;
  onClose: () => void;
}

export const EditBundleSheetContent = ({
  bundleId,
  onClose,
}: EditBundleSheetContentProps) => {
  const data = useBundleQuery(bundleId);

  return (
    <SheetContent class="flex flex-col h-full">
      <SheetHeader class="mb-4">
        <SheetTitle>Edit {bundleId}</SheetTitle>
      </SheetHeader>

      <Show
        when={data.data}
        fallback={
          data.isFetched ? (
            <SheetDescription>
              No update bundle found for bundle id {bundleId}
            </SheetDescription>
          ) : (
            <Skeleton height={374} radius={10} />
          )
        }
      >
        {(bundle) => (
          <EditBundleSheetForm bundle={bundle()} onEditSuccess={onClose} />
        )}
      </Show>

      <div class="mt-auto gap-3 pt-4 grid grid-cols-1 sm:grid-cols-2">
        <RolloutStatsDialog bundleId={bundleId} />
        <Show when={data.data}>
          {(bundle) => <PromoteChannelDialog bundle={bundle()} />}
        </Show>

        <EmergencyRollbackButton bundleId={bundleId} />
        <DeleteBundleDialog bundleId={bundleId} onDeleteSuccess={onClose} />
      </div>
    </SheetContent>
  );
};
