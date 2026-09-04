import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { LOG_PREFIX } from "./env";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// For hooks and actions: herdr captures stdout/stderr into
// `herdr plugin log list`. Keep stderr for problems only so normal operation
// leaves a clean log.
export function hookLogger(debug: boolean): Logger {
  return {
    debug: (m) => {
      if (debug) console.log(`${LOG_PREFIX} ${m}`);
    },
    info: (m) => console.log(`${LOG_PREFIX} ${m}`),
    warn: (m) => console.error(`${LOG_PREFIX} warning: ${m}`),
    error: (m) => console.error(`${LOG_PREFIX} error: ${m}`),
  };
}

export const ROTATE_BYTES = 512 * 1024;

// For the detached poller, whose output herdr does not capture. Appends
// timestamped lines and rotates once to `<path>.1` when the file grows large.
export function fileLogger(path: string, debug: boolean): Logger {
  const write = (level: string, message: string) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`);
    } catch {
      // Logging must never take the poller down.
    }
  };
  return {
    debug: (m) => {
      if (debug) write("debug", m);
    },
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
