// @vitest-environment node
/**
 * The Obscura connection seam. What Norish owns here is small on purpose:
 * which endpoint it dials, that one healthy connection is reused, that a
 * connection Obscura dropped is replaced on the next call, and that a failure
 * reads as an Obscura problem. Everything past `connectOverCDP` is Obscura's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockConnectOverCDP } = vi.hoisted(() => ({ mockConnectOverCDP: vi.fn() }));

vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: mockConnectOverCDP },
}));

vi.mock("@norish/config/env-config-server", () => ({
  SERVER_CONFIG: { OBSCURA_ENDPOINT: "ws://obscura.test:9222" },
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) =>
    hostname === "dual.railway.internal"
      ? [
          { address: "fd12:3456::7", family: 6 },
          { address: "10.250.0.7", family: 4 },
        ]
      : [{ address: "fd12:3456::7", family: 6 }]
  ),
}));

vi.mock("@norish/shared-server/logger", () => ({
  serverLogger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** A fresh module instance, so the cached connection never leaks across tests. */
async function loadModule() {
  vi.resetModules();

  return import("@norish/api/obscura");
}

function connectedBrowser() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("getBrowser – the Obscura connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects to the configured Obscura endpoint", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser } = await loadModule();

    await expect(getBrowser()).resolves.toBe(browser);
    expect(mockConnectOverCDP).toHaveBeenCalledExactlyOnceWith("ws://obscura.test:9222");
  });

  it("reuses one healthy connection across imports", async () => {
    mockConnectOverCDP.mockResolvedValue(connectedBrowser());

    const { getBrowser } = await loadModule();
    const first = await getBrowser();

    await expect(getBrowser()).resolves.toBe(first);
    expect(mockConnectOverCDP).toHaveBeenCalledOnce();
  });

  it("opens one connection when two imports arrive while Obscura is cold", async () => {
    const browser = connectedBrowser();
    let connect: (value: unknown) => void = () => {};

    mockConnectOverCDP.mockImplementation(
      () =>
        new Promise((resolve) => {
          connect = resolve;
        })
    );

    const { getBrowser } = await loadModule();
    // Both start before either finishes: without shared in-flight state the
    // second connection would orphan the first, and shutdown would only know
    // about one of them.
    const first = getBrowser();
    const second = getBrowser();

    connect(browser);

    await expect(first).resolves.toBe(browser);
    await expect(second).resolves.toBe(browser);
    expect(mockConnectOverCDP).toHaveBeenCalledOnce();
  });

  it("replaces the connection on the next request after Obscura disconnects", async () => {
    const dropped = connectedBrowser();
    const replacement = connectedBrowser();

    mockConnectOverCDP.mockResolvedValueOnce(dropped).mockResolvedValueOnce(replacement);

    const { getBrowser } = await loadModule();

    await getBrowser();
    dropped.isConnected.mockReturnValue(false);

    await expect(getBrowser()).resolves.toBe(replacement);
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable endpoint as an Obscura failure", async () => {
    mockConnectOverCDP.mockRejectedValue(new Error("ECONNREFUSED"));

    const { getBrowser } = await loadModule();

    await expect(getBrowser()).rejects.toThrow(/Obscura/);
    await expect(getBrowser()).rejects.toThrow(/OBSCURA_ENDPOINT/);
  });

  it("retries the connection after a failure instead of caching it", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue(browser);

    const { getBrowser } = await loadModule();

    await expect(getBrowser()).rejects.toThrow();
    await expect(getBrowser()).resolves.toBe(browser);
  });
});

describe("closeBrowser – process shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes the cached connection and forgets it", async () => {
    const browser = connectedBrowser();

    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser, closeBrowser } = await loadModule();

    await getBrowser();
    await closeBrowser();

    expect(browser.close).toHaveBeenCalledOnce();

    await getBrowser();
    expect(mockConnectOverCDP).toHaveBeenCalledTimes(2);
  });

  it("survives a connection that fails to close", async () => {
    const browser = connectedBrowser();

    browser.close.mockRejectedValue(new Error("already gone"));
    mockConnectOverCDP.mockResolvedValue(browser);

    const { getBrowser, closeBrowser } = await loadModule();

    await getBrowser();
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});

describe("dialledEndpoint – how Chromium is reached", () => {
  it("dials Obscura exactly as configured", async () => {
    const { dialledEndpoint } = await loadModule();

    await expect(dialledEndpoint("ws://obscura.test:9222", "obscura")).resolves.toBe(
      "ws://obscura.test:9222"
    );
  });

  it("dials Chromium by address, since its DevTools server refuses a service name", async () => {
    const { dialledEndpoint } = await loadModule();

    await expect(dialledEndpoint("http://localhost:9223", "chromium")).resolves.toBe(
      "http://localhost:9223"
    );
    await expect(dialledEndpoint("http://127.0.0.1:9222", "chromium")).resolves.toBe(
      "http://127.0.0.1:9222"
    );
    await expect(
      dialledEndpoint("http://chromium.railway.internal:9222", "chromium")
    ).resolves.toBe("http://[fd12:3456::7]:9222");
    // IPv4 first: the image listens on IPv4 only.
    await expect(dialledEndpoint("http://dual.railway.internal:9222", "chromium")).resolves.toBe(
      "http://10.250.0.7:9222"
    );
  });
});
