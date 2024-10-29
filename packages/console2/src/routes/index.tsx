import { createAsync } from "@solidjs/router";
import { createEffect, createSignal, onMount } from "solid-js";
import { api } from "~/lib/api";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";
export default function Home() {
  const data = createAsync(() => api.hotUpdater.getUpdateSources.query());
  const [selectedBundleVersion, setSelectedBundleVersion] = createSignal<
    number | null
  >(null);

  createEffect(() => {
    console.log("AA", data());
  });
  onMount(() => {
    console.log("BB");
  });

  return (
    <main class="w-full space-y-2.5">
      <DataTable
        // TODO: columns가 문제인듯
        columns={columns}
        data={data}
        onRowClick={(row) => {
          console.log(row);
          setSelectedBundleVersion(row.bundleVersion);
        }}
      />
      {/* 
      <Sheet
        open={selectedBundleVersion() !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedBundleVersion(null);
          }
        }}
      >
        <EditUpdateSourceSheetContent
          bundleVersion={selectedBundleVersion() ?? 0} // TODO: fix this
          onClose={() => setSelectedBundleVersion(null)}
        />
      </Sheet> */}
    </main>
  );
}
