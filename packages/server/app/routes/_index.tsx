import { Check, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type UpdateSource, getCwd, loadConfig } from "@hot-updater/plugin-core";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { Sidebar } from "@/components/Sidebar";
import { formatDateTimeFromBundleVersion } from "@/lib/date";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  redirect,
} from "@remix-run/node";
import { json, useLoaderData } from "@remix-run/react";
import { useState } from "react";

export const meta: MetaFunction = () => {
  return [
    { title: "New Remix App" },
    { name: "description", content: "Welcome to Remix!" },
  ];
};

export async function loader({ context }: LoaderFunctionArgs) {
  const { user } = context;
  if (!user) {
    return redirect("/login");
  }

  const { deploy } = await loadConfig();
  const deployPlugin = deploy({
    cwd: getCwd(),
  });

  const updateSources = await deployPlugin.getUpdateJson();
  return json({
    user,
    updateSources,
  });
}



export async function action({
  request,
}: ActionFunctionArgs) {
  const body = await request.formData();
  const source = {
    bundleVersion: Number(body.get("bundleVersion")?.toString()) || Number.NaN,
    targetVersion: body.get("targetVersion")?.toString() || "",
    description: body.get("description")?.toString() || "",
    forceUpdate: body.get("forceUpdate")?.toString() === "on",
    enabled: body.get("enabled")?.toString() === "on",
  }

  const { deploy } = await loadConfig();
  const deployPlugin = deploy({
    cwd: getCwd(),
  });

  if( Number.isNaN(source.bundleVersion)) {
    return redirect("/");
  }
  
  await deployPlugin.updateUpdateJson(source.bundleVersion, source);
  await deployPlugin.commitUpdateJson();

  return redirect("/");
}


const columnHelper = createColumnHelper<UpdateSource>();

const columns = [
  columnHelper.accessor("platform", {
    header: "Platform",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("targetVersion", {
    header: "Target Version",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("enabled", {
    header: "Enabled",
    cell: (info) =>
      info.getValue() ? (
        <div className="flex flex-row items-center gap-2">
          <Check />
          <p>Enabled</p>
        </div>
      ) : (
        <div className="flex flex-row items-center gap-2">
          <X />
          <p>Disabled</p>
        </div>
      ),
  }),
  columnHelper.accessor("description", {
    header: "Description",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("bundleVersion", {
    header: "Created At",
    cell: (info) => formatDateTimeFromBundleVersion(String(info.getValue())),
  }),
];


export default function Index() {
  const { user, updateSources } = useLoaderData<typeof loader>();

  const table = useReactTable({
    data: updateSources,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });


  const [selectedSource, setSelectedSource] = useState<UpdateSource | null>(null);

  return (
    <div
      className="flex flex-col w-full min-h-screen overflow-hidden bg-muted/40"
      onClick={() => {
        setSelectedSource(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setSelectedSource(null);
        }
      }}
    >
      <header className="sticky top-0 z-30 flex items-center gap-4 px-4 border-b h-14 bg-background sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
        <Breadcrumb className="hidden md:flex">
          <BreadcrumbList>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>App Updates</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="relative flex-1 ml-auto md:grow-0">
          <div className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />

          <Avatar>
            <AvatarImage src={user.avatarUrl} />
            <AvatarFallback>
              {user.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <p>{user.username}</p>
        </div>

        <form action="/api/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>
      <main className="grid items-start flex-1 gap-4 p-4 sm:px-6 sm:py-0 md:gap-8">
        <Card className="w-full overflow-hidden">
          <CardHeader className="px-6 py-4 bg-muted/50">
            <CardTitle>App Updates</CardTitle>
            <CardDescription>Manage your application updates.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();

                      setSelectedSource(row.original);
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>

      {selectedSource ? <Sidebar source={selectedSource} open={Boolean(selectedSource)} onClose={() => setSelectedSource(null)} /> : null}
    </div>
  );
}
