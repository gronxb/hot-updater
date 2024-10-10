import { trpc } from "@/lib/trpc";
import { Redirect } from "wouter";
import { columns } from "./update-sources/columns";
import { DataTable } from "./update-sources/data-table";

export const HomePage = () => {
  const { data } = trpc.updateSources.useQuery();

  const { data: isConfigLoaded } = trpc.isConfigLoaded.useQuery();

  if (!isConfigLoaded) {
    return <Redirect to="/empty-config" />;
  }
  return (
    <div className="w-full space-y-2.5">
      <DataTable columns={columns} data={data ?? []} />
    </div>
  );
};
