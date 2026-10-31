import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

import { ShortHash } from "./ShortHash";

/**
 * A build's commit as git shows it, its first 7 characters: a link to the
 * commit when `console.gitUrl` is set, else a button that copies the full
 * SHA. The full SHA shows on hover either way.
 */
export function CommitLink({ hash }: { readonly hash: string | null }) {
  const config = useConfigQuery();
  if (hash === null) return <span className="text-muted-foreground">—</span>;
  const url = getCommitUrl(config.data?.console.gitUrl, hash);
  return url === null ? (
    <ShortHash label="commit" length={7} value={hash} />
  ) : (
    <a
      className="font-mono text-xs whitespace-nowrap underline-offset-4 hover:underline"
      href={url}
      onClick={(event) => event.stopPropagation()}
      rel="noreferrer"
      target="_blank"
      title={hash}
      translate="no"
    >
      {hash.slice(0, 7)}
    </a>
  );
}
