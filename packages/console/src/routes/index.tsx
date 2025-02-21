import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { useNavigate, useParams } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
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
  const queryClient = useQueryClient();

  const bundleId = params.bundleId;

  const data = createQuery(() => ({
    queryKey: ["getBundles"],
    queryFn: () => {
      return api.getBundles.$get().then((res) => res.json());
    },
  }));

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
      queryClient.invalidateQueries({ queryKey: ["getBundles"] });
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
