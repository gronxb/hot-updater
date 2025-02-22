import { Sheet } from "@/components/ui/sheet";
import { createBundlesQuery } from "@/lib/api";
import { sleep } from "@/lib/utils";
import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, createMemo } from "solid-js";
import { Show, Suspense, createSignal } from "solid-js";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";
import { EditBundleSheetContent } from "./_components/edit-bundle-sheet-content";

export default function Home() {
  const params = useParams();
  const navigate = useNavigate();

  const bundleId = params.bundleId;

  const data = createBundlesQuery();

  const [selectedBundleId, setSelectedBundleId] = createSignal<string | null>(
    bundleId,
  );

  createEffect(() => {
    if (!selectedBundleId()) {
      navigate("/", { replace: true });
      return;
    }
    navigate(`/${selectedBundleId()}`, { replace: true });
  });

  createEffect(() => {
    if (isOpen()) {
      return;
    }
    sleep(500).then(() => setSelectedBundleId(null));
  });

  const dataForTable = createMemo(() => data.data || []);
  const [isOpen, setIsOpen] = createSignal(true);

  const handleClose = () => {
    setIsOpen(false);
  };

  return (
    <>
      <Sheet open={isOpen()} onOpenChange={setIsOpen}>
        <DataTable
          columns={columns}
          data={dataForTable}
          onRowClick={(row) => {
            setSelectedBundleId(row.id);
          }}
        />
        <Show when={selectedBundleId()}>
          <Suspense>
            <EditBundleSheetContent
              bundleId={selectedBundleId()!}
              onClose={handleClose}
            />
          </Suspense>
        </Show>
      </Sheet>
    </>
  );
}
