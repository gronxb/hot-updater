import type { UpdateSource } from "@hot-updater/core";
import type { RouteDefinition } from "@solidjs/router";
import { cache, createAsync } from "@solidjs/router";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";

const getData = cache(async (): Promise<UpdateSource[]> => {
  // Fetch data from your API here.
  // console.log(await window.electron.ipcRenderer.send("getUpdateJson"));
  return window.api.getUpdateJson();
}, "data");

export const route: RouteDefinition = {
  load: () => getData(),
};

export const Home = () => {
  const data = createAsync(() => getData());

  return (
    <div class="w-full space-y-2.5">
      <DataTable columns={columns} data={data} />
    </div>
  );
};
