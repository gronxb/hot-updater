import type { UpdateSource } from "@hot-updater/utils";
import type { ColumnDef } from "@tanstack/solid-table";

const XIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    class="size-6"
  >
    <path
      fill-rule="evenodd"
      d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z"
      clip-rule="evenodd"
    />
  </svg>
);

const CheckIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    class="size-6"
  >
    <path
      fill-rule="evenodd"
      d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
      clip-rule="evenodd"
    />
  </svg>
);

const formatDateTimeFromBundleVersion = (input: string): string => {
  const year = input.substring(0, 4);
  const month = input.substring(4, 6);
  const day = input.substring(6, 8);
  const hour = input.substring(8, 10);
  const minute = input.substring(10, 12);
  const second = input.substring(12, 14);

  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
};

export const columns: ColumnDef<UpdateSource>[] = [
  {
    accessorKey: "platform",
    header: "Platform",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "targetVersion",
    header: "Target Version",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "enabled",
    header: "Enabled",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <CheckIcon />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <XIcon />
        </div>
      ),
  },
  {
    accessorKey: "forceUpdate",
    header: "Force Update",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <CheckIcon />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <XIcon />
        </div>
      ),
  },
  {
    accessorKey: "description",
    header: "Description",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: (info) => formatDateTimeFromBundleVersion(String(info.getValue())),
  },
];
