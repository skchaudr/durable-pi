// prime-backend: a dpi device (API v1) whose agents are Prime sessions, reached through a PrimeDriver.
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig, type BackendConfig } from "./config.js";
import { createApp } from "./app.js";
import type { PrimeDriver } from "./driver.js";

const config = loadConfig();
// The driver lives in its own module; the specifier is a variable so this file type-checks before it exists.
const driverModule = "./acp-driver.js";
const { default: createDriver } = (await import(driverModule)) as {
  default: (config: BackendConfig) => PrimeDriver | Promise<PrimeDriver>;
};
const driver = await createDriver(config);
const { app, svc } = await createApp(config, driver);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`prime-backend "${config.name}" (uid ${svc.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await svc.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
