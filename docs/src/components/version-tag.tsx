import { Badge } from "@/components/ui/badge";

interface VersionTagProps {
  version?: string;
}

export function VersionTag({ version }: VersionTagProps) {
  if (!version) {
    return null;
  }

  return <Badge variant="secondary">Since {version}+</Badge>;
}
