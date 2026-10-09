import {
  type DateTimeText,
  describeRule,
  type RemoteConfigCondition,
} from "@/lib/remote-config-draft";

/** A condition's rules in a few words, unless its name already says them. */
export function RuleSummary({
  condition,
  dateTimeText,
}: {
  readonly condition: RemoteConfigCondition;
  readonly dateTimeText: DateTimeText;
}) {
  const text = condition.rules
    .map((rule) => describeRule(rule, dateTimeText))
    .join(" · ");
  return text === condition.name ? null : (
    <p className="text-xs text-muted-foreground">{text}</p>
  );
}
