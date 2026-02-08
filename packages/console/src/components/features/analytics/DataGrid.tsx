import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type DataGridColumn<T> = {
  key: string;
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (row: T) => React.ReactNode;
};

export function DataGrid<T>({
  data,
  columns,
  getRowKey,
  onRowClick,
  empty,
  className,
}: {
  data: T[];
  columns: Array<DataGridColumn<T>>;
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
}) {
  if (data.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <Table variant="editorial" className={cn("analytics-grid-table", className)}>
      <TableHeader className="bg-[var(--raised-surface)]/70">
        <TableRow className="hover:bg-transparent border-b-[var(--panel-border)]">
          {columns.map((column) => (
            <TableHead
              key={column.key}
              className={cn(
                "h-11 px-4 text-[0.68rem] uppercase tracking-[0.08em] text-muted-foreground",
                column.headerClassName,
              )}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow
            key={getRowKey(row)}
            className={cn(
              "border-b-[var(--panel-border)]/70 hover:bg-[var(--raised-surface)]/80",
              onRowClick && "cursor-pointer",
            )}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((column) => (
              <TableCell
                key={`${getRowKey(row)}-${column.key}`}
                className={cn("px-4 py-2.5", column.cellClassName)}
              >
                {column.render(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
