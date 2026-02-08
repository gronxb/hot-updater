export function getSuccessRateVariant(
  rate: number,
): "success" | "warning" | "error" {
  if (rate >= 90) return "success";
  if (rate >= 70) return "warning";
  return "error";
}

export function getEventTypeVariant(
  eventType: string,
): "success" | "warning" {
  return eventType === "PROMOTED" ? "success" : "warning";
}
