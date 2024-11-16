import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { Suspense, createResource, createSignal } from "solid-js";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";
import { EditBundleSheetContent } from "./_components/edit-bundle-sheet-content";

export default function Home() {
  const [data, { refetch }] = createResource(() =>
    api.getBundles.$get().then((res) => res.json()),
  );

  const [selectedBundleId, setSelectedBundleId] = createSignal<string | null>(
    null,
  );

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <main class="w-full space-y-2.5">
        <DataTable
          columns={columns}
          data={data}
          onRowClick={(row) => {
            console.log(row);
            setSelectedBundleId(row.id);
          }}
        />

        <Sheet
          open={selectedBundleId() !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedBundleId(null);
            }
          }}
        >
          {selectedBundleId() && (
            <EditBundleSheetContent
              bundleId={selectedBundleId()!}
              onClose={() => {
                setSelectedBundleId(null);
                refetch();
              }}
            />
          )}
        </Sheet>
      </main>
    </Suspense>
  );
}
