/**
 * A command to print, broken at spaces with ` \` once a line would pass
 * `width`, each continuation indented two spaces, so a terminal never wraps
 * it mid-word and it still pastes as one command.
 */
export const formatCommand = (words: readonly string[], width = 74): string => {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > width - 2) {
      lines.push(`${line} \\`);
      line = `  ${word}`;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines.join("\n");
};
