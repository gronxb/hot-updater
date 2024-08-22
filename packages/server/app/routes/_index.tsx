import { Check, Plus, X } from "lucide-react";

/**
 * v0 by Vercel.
 * @see https://v0.dev/t/UGRMCDSNnIz
 * Documentaion: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { UpdateSource } from "@hot-updater/internal";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { Textarea } from "@/components/ui/textarea";
import { formatDateTimeFromBundleVersion } from "@/lib/date";
import { cn } from "@/lib/utils";
import {
  type LoaderFunctionArgs,
  type MetaFunction,
  redirect,
} from "@remix-run/node";
import { Link, json, useLoaderData } from "@remix-run/react";
import { useState } from "react";

export const meta: MetaFunction = () => {
  return [
    { title: "New Remix App" },
    { name: "description", content: "Welcome to Remix!" },
  ];
};

export function loader({ context }: LoaderFunctionArgs) {
  const { user } = context;
  if (!user) {
    return redirect("/login");
  }

  const updateSources = [
    {
      platform: "ios",
      targetVersion: "1.0",
      file: "http://example.com/bundle.zip",
      hash: "hash",
      forceUpdate: false,
      enabled: true,
      description: "Bug fixes and performance improvements",
      bundleVersion: 20240821000000,
    },
    {
      platform: "ios",
      targetVersion: "1.0",
      file: "http://example.com/bundle.zip",
      hash: "hash",
      forceUpdate: false,
      enabled: true,
      description: "Bug fixes and performance improvements",
      bundleVersion: 20240821000001,
    },
    {
      platform: "ios",
      targetVersion: "1.0",
      file: "http://example.com/bundle.zip",
      hash: "hash",
      forceUpdate: false,
      enabled: true,
      description: "Bug fixes and performance improvements",
      bundleVersion: 20240821000002,
    },
    {
      platform: "ios",
      targetVersion: "1.0",
      file: "http://example.com/bundle.zip",
      hash: "hash",
      forceUpdate: false,
      enabled: false,
      description: "Bug fixes and performance improvements",
      bundleVersion: 20240821000003,
    },
    {
      platform: "ios",
      targetVersion: "1.0",
      file: "http://example.com/bundle.zip",
      hash: "hash",
      description: "Bug fixes and performance improvements",
      forceUpdate: false,
      enabled: true,
      bundleVersion: 20240821000003,
    },
  ] as UpdateSource[];

  return json({
    user,
    updateSources,
  });
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

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div
      className="flex flex-col w-full min-h-screen overflow-hidden bg-muted/40"
      onClick={() => {
        setIsSidebarOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setIsSidebarOpen(false);
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
                      setIsSidebarOpen(true);
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
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="fixed bottom-4 right-4 sm:hidden"
            >
              <Plus className="w-5 h-5" />
              <span className="sr-only">New Update</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="sm:max-w-md">
            <div className="grid gap-6 p-6">
              <div className="grid gap-1">
                <div className="text-2xl font-medium">iOS 2.5.1</div>
                <div className="text-muted-foreground">
                  Bug fixes and performance improvements
                </div>
              </div>
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <div className="font-medium">Platform</div>
                  <div>iOS</div>
                </div>
                <div className="grid gap-2">
                  <div className="font-medium">Target Version</div>
                  <div>2.5.1</div>
                </div>
                <div className="grid gap-2">
                  <div className="font-medium">Description</div>
                  <div>
                    This update includes bug fixes and performance improvements
                    to enhance the user experience.
                  </div>
                </div>
                <div className="grid gap-2">
                  <div className="font-medium">Created At</div>
                  <div>2023-06-15 10:24 AM</div>
                </div>
                <div className="grid gap-2">
                  <div className="font-medium">Actions</div>
                  <div className="flex items-center gap-2">
                    <Checkbox id="forceUpdate">Force Update</Checkbox>
                    <Checkbox id="enabled" defaultChecked>
                      Enabled
                    </Checkbox>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button>Promote to Production</Button>
                <Button variant="outline">Delete</Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </main>
      {/* Sidebar */}

      <aside
        className={cn(
          "fixed right-0 z-50 flex-col hidden min-w-64 h-full gap-4 p-4 sm:flex bg-muted ease-in-out duration-300 shadow-lg",
          isSidebarOpen ? "translate-x-0" : "translate-x-full",
        )}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <X
          className={cn("fixed w-5 h-5 cursor-pointer top-4 right-4")}
          onClick={(e) => {
            e.stopPropagation();
            setIsSidebarOpen(false);
          }}
        />
        <div className="font-medium">Edit</div>

        <div>
          <label htmlFor="targetVersion">Target Version</label>
          <Input id="targetVersion" value="13.2" />
        </div>

        <div>
          <label htmlFor="description">Description</label>
          <Textarea id="description" placeholder="hi" />
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Checkbox id="forceUpdate">Force Update</Checkbox>
            <label htmlFor="forceUpdate">Force Update</label>
          </div>
          <p className="text-xs text-gray-500">
            When enabled, this update will require users to update before
            continuing to use the application.
          </p>

          <div className="flex items-center gap-2">
            <Checkbox id="enabled" defaultChecked>
              Enabled
            </Checkbox>
            <label htmlFor="enabled">Enabled</label>
          </div>
          <p className="text-xs text-gray-500">
            When disabled, this update will not be available to your users.
          </p>
          <Button className="mt-6">Save</Button>
        </div>
      </aside>
    </div>
  );
}
