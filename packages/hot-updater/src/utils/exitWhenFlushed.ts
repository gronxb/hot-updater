/**
 * Ends the process once stdout and stderr have written what is queued. A
 * command whose config opened a database pool or client it does not own,
 * such as a mysql2 pool or a MongoClient, would otherwise stay alive after
 * its work is done; on macOS a pipe writes asynchronously, so exiting
 * without waiting could cut `--json` output short.
 */
export const exitWhenFlushed = (code = 0): Promise<never> =>
  new Promise<never>(() => {
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) process.exit(code);
    };
    process.stdout.write("", done);
    process.stderr.write("", done);
  });
