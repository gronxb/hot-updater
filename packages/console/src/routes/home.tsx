import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Toast,
  ToastContent,
  ToastProgress,
  ToastTitle,
} from "@/components/ui/toast";
import type { UpdateSource } from "@hot-updater/core";
import { toaster } from "@kobalte/core";
import type { RouteDefinition } from "@solidjs/router";
import { cache, createAsync } from "@solidjs/router";
import { columns } from "./_components/columns";
import { DataTable } from "./_components/data-table";

const getData = cache(async (): Promise<UpdateSource[]> => {
  // Fetch data from your API here.
  return window.app.getUpdateSources();
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
