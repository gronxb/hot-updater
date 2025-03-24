import { Sheet } from "@/components/ui/sheet";
import { useFilter } from "@/hooks/useFilter";
import { createMemo } from "solid-js";
import { Show, Suspense } from "solid-js";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";
import { EditBundleSheetContent } from "./_components/edit-bundle-sheet-content";

export default function Home() {
  const { bundleIdFilter, setBundleIdFilter } = useFilter();

  const isOpen = createMemo(() => bundleIdFilter() !== null);

  const handleClose = () => {
    setBundleIdFilter(null);
  };

  return (
    <Sheet
      open={isOpen()}
      onOpenChange={(open) => {
        if (!open) {
          setBundleIdFilter(null);
        }
      }}
    >
      <DataTable
        columns={columns}
        onRowClick={(row) => {
          setBundleIdFilter(row.id);
        }}
      />
      <Show when={bundleIdFilter()}>
        <Suspense>
          <EditBundleSheetContent
            bundleId={bundleIdFilter()!}
            onClose={handleClose}
          />
        </Suspense>
      </Show>
    </Sheet>
  );
}
