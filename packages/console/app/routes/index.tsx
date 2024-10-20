// import * as fs from "fs";
// import { createFileRoute, useRouter } from "@tanstack/react-router";
// import { createServerFn } from "@tanstack/start";

import { Sheet } from "@/components/ui/sheet";
import { columns } from "@/pages/home/columns";
import { DataTable } from "@/pages/home/data-table";
import { EditUpdateSourceSheetContent } from "@/pages/home/edit-update-source-sheet-content";
import type { UpdateSource } from "@hot-updater/utils";
import { createFileRoute } from "@tanstack/react-router";
import { overlay } from "overlay-kit";

// const filePath = "count.txt";

// async function readCount() {
// 	return Number.parseInt(
// 		await fs.promises.readFile(filePath, "utf-8").catch(() => "0"),
// 	);
// }

// const getCount = createServerFn("GET", () => {
// 	return readCount();
// });

// const updateCount = createServerFn("POST", async (addBy: number) => {
// 	const count = await readCount();
// 	await fs.promises.writeFile(filePath, `${count + addBy}`);
// });

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => [] as UpdateSource[],
});

function Home() {
  //   const router = useRouter();
  const data = Route.useLoaderData();

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
}
