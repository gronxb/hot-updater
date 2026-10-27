import { HashValueDisplay } from "@/components/HashValueDisplay";
import { useConfigQuery } from "@/lib/api";
import { getCommitUrl } from "@/lib/git";

/** A build's commit, linked through `console.gitUrl` when the config sets it. */
export function CommitLink({ hash }: { readonly hash: string | null }) {
  const config = useConfigQuery();
  if (hash === null) return <span className="text-muted-foreground">—</span>;
  const url = getCommitUrl(config.data?.console.gitUrl, hash);
  return url === null ? (
    <HashValueDisplay value={hash} maxLength={10} />
  ) : (
    <a
      className="font-mono text-xs underline-offset-4 hover:underline"
      href={url}
      onClick={(event) => event.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      {hash.slice(0, 7)}
    </a>
  );
}
