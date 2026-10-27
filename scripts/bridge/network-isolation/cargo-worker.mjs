import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const certificate = readFileSync("/wiki/tests/bridge/fixtures/cargo-cert.pem");
const privateKey = readFileSync("/wiki/tests/bridge/fixtures/cargo-key.pem");

const server = createServer(
  { cert: certificate, key: privateKey, minVersion: "TLSv1.2" },
  (request, response) => {
    const record = {
      method: request.method,
      path: request.url,
      servername: request.socket.servername,
      remoteAddress: request.socket.remoteAddress,
      authorized: request.headers.authorization === "Bearer fixture.game.token",
    };
    console.log(`CARGO_REQUEST ${JSON.stringify(record)}`);
    if (
      record.method !== "GET" ||
      record.path !== "/api/me" ||
      !record.authorized
    ) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ playerId: 54321, nickname: "fixture" }));
  },
);
server.on("connection", (socket) => {
  console.log(
    `CARGO_TCP ${JSON.stringify({ remoteAddress: socket.remoteAddress })}`,
  );
});
server.on("error", (error) => {
  console.error(`CARGO_FAILURE ${error.code || "server_error"}`);
  process.exitCode = 1;
});
server.listen(443, "0.0.0.0", () => console.log("CARGO_READY"));

process.once("SIGTERM", () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
