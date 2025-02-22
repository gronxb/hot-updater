import { Sheet } from "@/components/ui/sheet";
import { createBundlesQuery } from "@/lib/api";
import { useNavigate, useParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import {
  Show,
  Suspense,
  createEffect,
  createSignal,
  useTransition,
} from "solid-js";
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

  const [_, start] = useTransition();

  createEffect(() => {
    if (!selectedBundleId()) {
      navigate("/", { replace: true });
      return;
    }
    navigate(`/${selectedBundleId()}`, { replace: true });
  });

  const dataForTable = createMemo(() => data.data || []);

  const handleClose = () => {
    start(() => {
      setSelectedBundleId(null);
    });
  };

  return (
    <>
      <DataTable
        columns={columns}
        data={dataForTable}
        onRowClick={(row) => {
          start(() => {
            setSelectedBundleId(row.id);
          });
        }}
      />

      <Sheet
        open={selectedBundleId() !== null}
        onOpenChange={(open) =>
          !open &&
          start(() => {
            setSelectedBundleId(null);
          })
        }
      >
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
