import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { Suspense, createResource, createSignal } from "solid-js";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";
import { EditUpdateSourceSheetContent } from "./_components/edit-update-source-sheet-content";

export default function Home() {
  const [data, { refetch }] = createResource(() =>
    api.getUpdateSources.$get().then((res) => res.json()),
  );

  const [selectedBundleTimestamp, setSelectedBundleTimestamp] = createSignal<
    number | null
  >(null);

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <main class="w-full space-y-2.5">
        <DataTable
          columns={columns}
          data={data}
          onRowClick={(row) => {
            console.log(row);
            setSelectedBundleTimestamp(row.bundleTimestamp);
          }}
        />

        <Sheet
          open={selectedBundleTimestamp() !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedBundleTimestamp(null);
            }
          }}
        >
          {selectedBundleTimestamp() && (
            <EditUpdateSourceSheetContent
              bundleTimestamp={selectedBundleTimestamp()!}
              onClose={() => {
                setSelectedBundleTimestamp(null);
                refetch();
              }}
            />
          )}
        </Sheet>
      </main>
    </Suspense>
  );
}
