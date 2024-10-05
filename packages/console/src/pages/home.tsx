import { Button } from "@/components/ui/button";

import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { columns } from "./update-sources/columns";
import { DataTable } from "./update-sources/data-table";

export const HomePage = () => {
  const { data } = trpc.updateSources.useQuery();
  const utils = trpc.useUtils();

  const { mutate: push } = trpc.push.useMutation({
    onSuccess: () => {
      utils.updateSources.invalidate();
    },
  });

  return (
    <div className="w-full space-y-2.5">
      <Link href="/empty-config">Empty Config</Link>

      <Button onClick={() => push()}>PUSH</Button>
      <DataTable columns={columns} data={data ?? []} />
    </div>
  );
};
