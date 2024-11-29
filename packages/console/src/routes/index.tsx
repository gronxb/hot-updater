import logo from "@/assets/logo.png";

import { SplashScreen } from "@/components/spash-screen";

import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import {
  Show,
  Suspense,
  createResource,
  createSignal,
  useTransition,
} from "solid-js";
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
  const [_, start] = useTransition();

  return (
    <Suspense fallback={<SplashScreen />}>
      <main class="w-full space-y-2.5">
        <div class="flex flex-row items-center gap-1">
          <img src={logo} alt="Hot Updater Console" class="w-12 h-12" />
          <a
            href="https://github.com/gronxb/hot-updater"
            target="_blank"
            class="text-2xl font-light"
            rel="noreferrer"
          >
            Hot Updater Console
          </a>
        </div>

        <DataTable
          columns={columns}
          data={data}
          onRowClick={(row) => {
            start(() => {
              setSelectedBundleId(row.id);
            });
          }}
        />

        <Sheet
          open={selectedBundleId() !== null}
          onOpenChange={(open) =>
            !open && start(() => setSelectedBundleId(null))
          }
        >
          <Show when={selectedBundleId()}>
            <Suspense>
              <EditBundleSheetContent
                bundleId={selectedBundleId()!}
                onClose={() =>
                  start(() => {
                    setSelectedBundleId(null);
                    refetch();
                  })
                }
              />
            </Suspense>
          </Show>
        </Sheet>
      </main>
    </Suspense>
  );
}
