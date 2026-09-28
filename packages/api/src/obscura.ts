import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";

import { SERVER_CONFIG } from "@norish/config/env-config-server";
import { serverLogger as log } from "@norish/shared-server/logger";

/**
 * The connection to Obscura, the headless browser that renders pages for URL
 * imports. Obscura serves the Chrome DevTools Protocol, so Playwright Core
 * talks to it directly: `OBSCURA_ENDPOINT` is dialled as given, with no
 * debugger-metadata probe and no hostname rewriting in between.
 *
 * Chromium (`RENDER_ENGINE=chromium`) is the one exception. Its DevTools
 * server answers only a Host header that is an IP address or `localhost`, so
 * a service name such as `chromium.railway.internal` is resolved first and
 * the endpoint dialled by the address it resolves to.
 */
let browser: Browser | null = null;

/**
 * The connection attempt in flight, if there is one. Cached as a promise rather
 * than awaited per caller, so two imports arriving while Obscura is cold share
 * one connection instead of opening two and orphaning the first.
 */
let connecting: Promise<Browser> | null = null;

/** The endpoint to dial: as configured, or for Chromium, by IP address. */
export async function dialledEndpoint(
  endpoint: string,
  engine: "obscura" | "chromium"
): Promise<string> {
  if (engine !== "chromium") return endpoint;
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || isIP(hostname)) return endpoint;
  const { address, family } = await lookup(hostname);

  url.hostname = family === 6 ? `[${address}]` : address;

  return url.toString().replace(/\/$/, "");
}

export async function getBrowser(): Promise<Browser> {
  // One connection serves every import; contexts, not connections, are what
  // keeps concurrent imports isolated. A connection Obscura dropped — because
  // it restarted, say — is replaced here rather than by restarting Norish.
  if (browser?.isConnected()) return browser;
  if (connecting) return connecting;

  const endpoint = SERVER_CONFIG.OBSCURA_ENDPOINT;

  const engine = SERVER_CONFIG.RENDER_ENGINE ?? "obscura";
  const connection =
    engine === "chromium"
      ? dialledEndpoint(endpoint, engine).then((dialled) => chromium.connectOverCDP(dialled))
      : chromium.connectOverCDP(endpoint);

  connecting = connection
    .then((connected) => {
      browser = connected;

      return connected;
    })
    .catch((error: unknown) => {
      log.error({ err: error, endpoint }, "Failed to connect to Obscura");
      throw new Error(
        `Obscura is not reachable at ${endpoint}. Start the obscura service or check OBSCURA_ENDPOINT.`
      );
    })
    .finally(() => {
      // Cleared either way: a failed attempt must not be cached, so the next
      // import retries once Obscura is back.
      connecting = null;
    });

  return connecting;
}

export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      log.error({ err: error }, "Error closing the Obscura connection");
    }
    browser = null;
  }
}

// Graceful shutdown - register handlers only once
let shutdownHandlersRegistered = false;

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on("SIGINT", closeBrowser);
  process.on("SIGTERM", closeBrowser);
}

registerShutdownHandlers();
