import { Sheet } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { overlay } from "overlay-kit";
import { Redirect } from "wouter";
import { columns } from "./columns";
import { DataTable } from "./data-table";
import { EditUpdateSourceSheetContent } from "./edit-update-source-sheet-content";

export const HomePage = () => {
  const { data } = trpc.updateSources.useQuery();
  const { data: isConfigLoaded } = trpc.isConfigLoaded.useQuery();

  if (!isConfigLoaded) {
    return <Redirect to="/empty-config" />;
  }
  return (
    <div className="w-full space-y-2.5">
      <DataTable
        columns={columns}
        data={data ?? []}
        onModify={(row) => {
          overlay.open(({ isOpen, close }) => {
            return (
              <Sheet
                open={isOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    close();
                  }
                }}
              >
                <EditUpdateSourceSheetContent
                  bundleVersion={row.bundleVersion}
                  onClose={close}
                />
              </Sheet>
            );
          });
        }}
      />
    </div>
  );
};
