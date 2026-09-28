/**
 * The private-network guard a Chromium render runs under. Obscura refuses
 * loopback, RFC1918 and link-local targets itself, down to DNS resolution;
 * Chromium refuses nothing, so a URL import or a Store's Search Address could
 * otherwise have the server's browser read Redis, the database, or a cloud
 * metadata endpoint. Every request the page makes — the navigation, its
 * redirects, its scripts and its API calls — is checked against where its
 * host resolves before it is let through.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { BrowserContext } from "playwright-core";

import { parserLogger as log } from "@norish/shared-server/logger";

const PRIVATE = new BlockList();

PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("224.0.0.0", 3, "ipv4");
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");
PRIVATE.addSubnet("ff00::", 8, "ipv6");

/** Whether an IP address is one the server's own network answers on. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family !== 6) return true;
  // An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is still that address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];

  return mapped ? PRIVATE.check(mapped, "ipv4") : PRIVATE.check(address, "ipv6");
}

type Resolve = (hostname: string) => Promise<string[]>;

const resolveAll: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Whether a request may leave the browser. Only the web's own schemes reach a
 * network; `data:` and `blob:` never do. A host that does not resolve is
 * refused, and so is one where any address it resolves to is private, since
 * the browser may pick any of them.
 */
export async function isAllowedRequest(
  url: string,
  resolve: Resolve = resolveAll
): Promise<boolean> {
  let target: URL;

  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === "data:" || target.protocol === "blob:") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(target.protocol)) return false;
  const hostname = target.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const addresses = await resolve(hostname);

    return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

/** Refuse every request of this context that would reach a private address. */
export async function guardPrivateNetwork(
  context: BrowserContext,
  resolve: Resolve = resolveAll
): Promise<void> {
  // One lookup per host per render: a shop's page asks its CDN for dozens of files.
  const verdicts = new Map<string, Promise<boolean>>();

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    let origin: string;

    // Scheme and host together: `data:` and `file:` share an empty host.
    try {
      const target = new URL(url);

      origin = `${target.protocol}//${target.host}`;
    } catch {
      origin = url;
    }
    let verdict = verdicts.get(origin);

    if (!verdict) {
      verdict = isAllowedRequest(url, resolve);
      verdicts.set(origin, verdict);
    }
    if (await verdict) return route.continue();
    log.warn({ url }, "Refused a rendered page's request to a private address");

    return route.abort("blockedbyclient");
  });
}
