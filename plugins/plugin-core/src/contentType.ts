import mime from "mime";

export function getContentType(filePath: string): string {
  return mime.getType(filePath) ?? "application/octet-stream";
}
