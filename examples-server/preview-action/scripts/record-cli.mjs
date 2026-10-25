// Runs the CLI given as arguments, as the native build action's `cli` input,
// and appends everything it prints to PROOF_LOG, which the proof checks:
// the action itself never needs an output for the CLI's errors.
//
//   node scripts/record-cli.mjs node ../../packages/hot-updater/dist/index.mjs
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const log = process.env.PROOF_LOG;
if (!log) throw new Error("PROOF_LOG is not set.");
const [command, ...args] = process.argv.slice(2);

const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
for (const [stream, target] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    appendFileSync(log, chunk);
    target.write(chunk);
  });
}
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
