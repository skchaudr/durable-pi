// Device configuration: ~/.prime-backend/backend.env (or $DPI_ENV_FILE) plus CLI flags. Mirrors dpi-backend/src/config.ts.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  token: string;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.PRIME_HOME ?? join(homedir(), ".prime-backend"));
  const envFile = expand(flag("--env-file", env.DPI_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config: BackendConfig = {
    name: flag("--name", env.DPI_DEVICE_NAME ?? "prime-mini"),
    host: flag("--host", env.DPI_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.DPI_PORT ?? "4782")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.DPI_DATA_DIR ?? home))),
    startDirs: flag("--start-dirs", env.DPI_START_DIRS ?? "~/dpi-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    token: env.DPI_TOKEN ?? "",
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.token.length < 32)
    throw Error(`DPI_TOKEN is missing or shorter than 32 characters (looked in ${envFile}).`);
  return config;
}
