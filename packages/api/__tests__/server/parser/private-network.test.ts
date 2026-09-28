// @vitest-environment node
/**
 * The guard a Chromium render runs under, standing in for the private-network
 * protection Obscura has built in: a rendered page never reaches the server's
 * own network, whatever address it names or its host resolves to.
 */
import { describe, expect, it, vi } from "vitest";

import {
  guardPrivateNetwork,
  isAllowedRequest,
  isPrivateAddress,
} from "@norish/api/parser/private-network";

vi.mock("@norish/shared-server/logger", () => ({
  parserLogger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const publicHost = async () => ["93.184.215.14"];

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.215.14", "8.8.8.8", "2606:2800:220:1::1"])("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("isAllowedRequest", () => {
  it("lets a public shop through", async () => {
    await expect(isAllowedRequest("https://winmart.vn/search/chao", publicHost)).resolves.toBe(
      true
    );
  });

  it("refuses an address on the server's own network, written out", async () => {
    await expect(isAllowedRequest("http://127.0.0.1:6379/", publicHost)).resolves.toBe(false);
    await expect(isAllowedRequest("http://[::1]:5432/", publicHost)).resolves.toBe(false);
  });

  it("refuses a name that resolves to a private address, even once among public ones", async () => {
    const railway = async () => ["fd12::10"];
    const mixed = async () => ["93.184.215.14", "10.0.0.7"];

    await expect(isAllowedRequest("http://redis.railway.internal:6379", railway)).resolves.toBe(
      false
    );
    await expect(isAllowedRequest("https://rebind.example", mixed)).resolves.toBe(false);
  });

  it("refuses a name that does not resolve, and schemes that are not the web's", async () => {
    const unknown = async () => {
      throw new Error("ENOTFOUND");
    };

    await expect(isAllowedRequest("https://nowhere.invalid", unknown)).resolves.toBe(false);
    await expect(isAllowedRequest("file:///etc/passwd", publicHost)).resolves.toBe(false);
    await expect(isAllowedRequest("data:text/plain,hi", publicHost)).resolves.toBe(true);
  });
});

describe("guardPrivateNetwork", () => {
  it("continues a public request, aborts a private one, and looks each host up once", async () => {
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = {
      route: vi.fn(async (_pattern: string, fn: (route: unknown) => Promise<void>) => {
        handler = fn;
      }),
    };
    const resolve = vi.fn(async (host: string) =>
      host === "internal.test" ? ["10.0.0.2"] : ["93.184.215.14"]
    );
    const request = (url: string) => {
      const route = {
        request: () => ({ url: () => url }),
        continue: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      };

      return route;
    };

    await guardPrivateNetwork(context as never, resolve);

    const page = request("https://shop.test/search?q=bia");
    const script = request("https://shop.test/app.js");
    const internal = request("http://internal.test/admin");

    await handler?.(page);
    await handler?.(script);
    await handler?.(internal);

    expect(page.continue).toHaveBeenCalledOnce();
    expect(script.continue).toHaveBeenCalledOnce();
    expect(internal.abort).toHaveBeenCalledExactlyOnceWith("blockedbyclient");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
