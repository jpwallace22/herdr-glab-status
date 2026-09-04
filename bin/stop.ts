#!/usr/bin/env bun
// `stop-poller` action: stop the background poller and leave a marker so event
// hooks do not restart it. Tokens then expire after their TTL. The next herdr
// server start, or the `refresh` action, clears the marker and starts polling
// again.

import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { hookLogger } from "../src/log";
import { stopPoller } from "../src/poller-control";

const cfg = loadConfig(configDir());
const log = hookLogger(cfg.debug);
stopPoller(log);
