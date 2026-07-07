const normalizeGitUrl = (gitUrl: string) => {
  const trimmedGitUrl = gitUrl.trim();

  if (trimmedGitUrl.startsWith("git@")) {
    const sshMatch = trimmedGitUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);

    if (sshMatch) {
      return `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
  }

  if (trimmedGitUrl.startsWith("ssh://")) {
    try {
      const url = new URL(trimmedGitUrl);
      return `https://${url.hostname}${url.pathname}`
        .replace(/\/+$/, "")
        .replace(/\.git$/, "");
    } catch {
      return trimmedGitUrl.replace(/\/+$/, "").replace(/\.git$/, "");
    }
  }

  return trimmedGitUrl.replace(/\/+$/, "").replace(/\.git$/, "");
};

export const getCommitUrl = (
  gitUrl: string | undefined,
  commitHash: string,
) => {
  if (!gitUrl?.trim()) {
    return null;
  }

  const normalizedGitUrl = normalizeGitUrl(gitUrl);

  try {
    const { hostname } = new URL(normalizedGitUrl);

    if (hostname.includes("gitlab")) {
      return `${normalizedGitUrl}/-/commit/${commitHash}`;
    }

    if (hostname.includes("bitbucket")) {
      return `${normalizedGitUrl}/commits/${commitHash}`;
    }
  } catch {
    // Fall back to the default commit route for custom git hosts.
  }

  return `${normalizedGitUrl}/commit/${commitHash}`;
};
