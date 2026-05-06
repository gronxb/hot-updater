import { colors } from "@hot-updater/cli-tools";

type StringValue = string | number | boolean | null | undefined;

const LABEL_WIDTH = 9;

interface TableColumn<TKey extends string> {
  key: TKey;
  label?: string;
  format?: (value: string) => string;
}

const stringify = (value: StringValue): string =>
  value === null || value === undefined ? "" : String(value);

const colorIfPresent = (
  value: StringValue,
  color: (input: string) => string,
): string => {
  const text = stringify(value);
  return text ? color(text) : colors.dim("-");
};

export const ui = {
  title: (text: string): string => colors.bold(colors.cyan(text)),
  code: (text: StringValue): string => colors.dim(stringify(text)),
  command: (text: StringValue): string => colors.green(stringify(text)),
  label: (text: string): string => colors.dim(text.padEnd(LABEL_WIDTH)),
  muted: (text: StringValue): string => colors.dim(stringify(text)),
  id: (value: StringValue): string => colorIfPresent(value, colors.yellow),
  path: (value: StringValue): string => colorIfPresent(value, colors.dim),
  channel: (value: StringValue): string => colorIfPresent(value, colors.blue),
  platform: (value: StringValue): string => colorIfPresent(value, colors.cyan),
  version: (value: StringValue): string =>
    colorIfPresent(value, colors.magenta),
  success: (text: StringValue): string => colors.green(stringify(text)),
  danger: (text: StringValue): string => colors.red(stringify(text)),
  warning: (text: StringValue): string => colors.yellow(stringify(text)),
  status: (enabled: boolean): string =>
    enabled ? colors.green("enabled") : colors.red("disabled"),
  bool: (value: boolean): string =>
    value ? colors.green("yes") : colors.dim("no"),
  kv: (label: string, value: StringValue): string =>
    `    ${ui.label(`${label}:`)} ${stringify(value) || colors.dim("-")}`,
  line: (parts: string[]): string => parts.filter(Boolean).join(" "),
  block: (heading: string, lines: string[]): string =>
    [ui.title(heading), ...lines].join("\n"),
  table: <TKey extends string>(
    columns: readonly TableColumn<TKey>[],
    rows: readonly Record<TKey, StringValue>[],
  ): string => {
    const widths = columns.map((column) => {
      const label = column.label ?? column.key;
      return Math.max(
        label.length,
        ...rows.map((row) => stringify(row[column.key]).length),
      );
    });

    const border = (left: string, join: string, right: string): string =>
      `${left}${widths
        .map((width) => "─".repeat(width + 2))
        .join(join)}${right}`;

    const renderRow = (
      getValue: (column: TableColumn<TKey>) => string,
      format: boolean,
    ): string =>
      `│ ${columns
        .map((column, index) => {
          const width = widths[index] ?? 0;
          const value = getValue(column).padEnd(width);
          return format && column.format ? column.format(value) : value;
        })
        .join(" │ ")} │`;

    const header = renderRow((column) => column.label ?? column.key, false);
    const body = rows.map((row) =>
      renderRow((column) => stringify(row[column.key]), true),
    );

    return [
      border("┌", "┬", "┐"),
      colors.bold(header),
      border("├", "┼", "┤"),
      ...body,
      border("└", "┴", "┘"),
    ].join("\n");
  },
};
