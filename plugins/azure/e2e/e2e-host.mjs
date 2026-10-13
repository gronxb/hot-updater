// Runs Azure Functions Core Tools on an inner port and serves PORT in front
// of it. The Function routes every path to Hot Updater's client handler, which
// answers 404 at `/`, so this answers `/` for the E2E runner's readiness probe
// and passes every other request to the Function unchanged.
import { spawn } from "node:child_process";
import http from "node:http";

const [appDir] = process.argv.slice(2);
const port = Number(process.env.PORT);
const innerPort = port + 13000;

const host = spawn(
  "npx",
  [
    "-y",
    "azure-functions-core-tools@4.16.0",
    "start",
    "--port",
    String(innerPort),
  ],
  { cwd: appDir, stdio: "inherit" },
);
host.on("exit", (code, signal) => {
  console.error(`functions-host-exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    host.kill(signal);
    process.exit(0);
  });
}

http
  .createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ status: "ok", service: "Hot Updater Azure Function" }),
      );
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: innerPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
        answer.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error));
    });
    request.pipe(upstream);
  })
  .listen(port, () => {
    console.log(`e2e-host listening port=${port} functions-port=${innerPort}`);
  });
