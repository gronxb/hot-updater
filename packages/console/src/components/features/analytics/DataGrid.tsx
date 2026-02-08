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
    <Table
      variant="editorial"
      className={cn("analytics-grid-table", className)}
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent border-b">
          {columns.map((column) => (
            <TableHead
              key={column.key}
              className={cn(
                "h-10 px-4 text-[0.68rem] uppercase tracking-wider text-muted-foreground font-medium",
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
              "transition-colors hover:bg-muted/40",
              onRowClick && "cursor-pointer",
            )}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((column) => (
              <TableCell
                key={`${getRowKey(row)}-${column.key}`}
                className={cn("px-4 py-3", column.cellClassName)}
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
