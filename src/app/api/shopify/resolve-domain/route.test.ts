/**
 * SEC-07 endpoint-level verification for the public store-domain check.
 *
 * Only the network primitives are faked (DNS answers via node:dns, TCP/TLS via
 * node:https). Everything between them — route, input validation, rate
 * limiter, resolver, safeFetch URL rules, per-connection DNS validation and
 * redirect handling — is the real code. `connections` records every request
 * that got past DNS validation, i.e. everything that would have reached a
 * socket in production.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Site = { status: number; headers?: Record<string, string>; body?: string };

const net = vi.hoisted(() => ({
  dnsAnswers: {} as Record<string, string[]>,
  sites: {} as Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
  lookups: [] as string[],
  connections: [] as { host: string; address: string; path: string }[],
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ supabaseAdmin: { rpc } }));

vi.mock("node:dns", () => {
  const lookup = (
    hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses?: { address: string; family: number }[]) => void,
  ) => {
    net.lookups.push(hostname);
    const answers = net.dnsAnswers[hostname];
    if (!answers) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      return callback(err);
    }
    callback(null, answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  };
  return { default: { lookup }, lookup };
});

vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const request = (
    url: URL,
    options: { lookup: (host: string, opts: object, cb: (err: Error | null, address?: string) => void) => void },
    onResponse: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void,
  ) => {
    const req = new Emitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.write = () => {};
    req.destroy = (err?: Error) => {
      if (err) req.emit("error", err);
      req.emit("close");
    };
    req.end = () => {
      queueMicrotask(() => {
        // Exactly what the socket does first: resolve via the request's lookup.
        options.lookup(url.hostname, {}, (err, address) => {
          if (err) {
            req.emit("error", err);
            req.emit("close");
            return;
          }
          net.connections.push({ host: url.hostname, address: address ?? "", path: url.pathname });
          const site: Site = net.sites[`${url.hostname}${url.pathname}`] ?? { status: 404 };
          const res = Object.assign(new Emitter(), { statusCode: site.status, headers: site.headers ?? {} });
          onResponse(res);
          if (site.body) res.emit("data", Buffer.from(site.body));
          res.emit("end");
          req.emit("close");
        });
      });
    };
    return req;
  };
  return { default: { request }, request };
});

import { POST } from "./route";

const resolve = (domain: unknown, ip = "203.0.113.7") =>
  POST(
    new Request("http://localhost/api/shopify/resolve-domain", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ domain }),
    }),
  );

const PUBLIC_IP = "23.227.38.65"; // a public address (Shopify edge range)

beforeEach(() => {
  net.dnsAnswers = {};
  net.sites = {};
  net.lookups = [];
  net.connections = [];
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});

describe("rate limiting (per client IP)", () => {
  it("returns 429 once the per-IP limit is exhausted, before any outbound request", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const response = await resolve("shop.example.com");
    expect(response.status).toBe(429);
    expect(net.lookups).toEqual([]);
    expect(net.connections).toEqual([]);
  });

  it("limits by client IP: 20 checks per 10 minutes", async () => {
    await resolve("a.example.com", "198.51.100.1");
    await resolve("a.example.com", "198.51.100.2");
    expect(rpc).toHaveBeenNthCalledWith(1, "check_rate_limit", {
      p_key: "shopify:resolve-domain:ip:198.51.100.1",
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(rpc.mock.calls[1][1].p_key).toBe("shopify:resolve-domain:ip:198.51.100.2");
  });

  it("fails CLOSED when the limiter is unavailable (no unlimited outbound fetching)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    const errored = await resolve("shop.example.com");
    expect(errored.status).toBe(503);

    rpc.mockRejectedValue(new Error("network down"));
    const thrown = await resolve("shop.example.com");
    expect(thrown.status).toBe(503);

    expect(net.lookups).toEqual([]);
    expect(net.connections).toEqual([]);
  });
});

describe("private and internal destinations are never contacted", () => {
  it.each([
    "127.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "10.0.0.1",
    "192.168.1.10:8080",
    "0x7f.0.0.1",
    "[::1]",
    "localhost",
  ])("refuses %s without any DNS lookup or connection", async (input) => {
    const response = await resolve(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isShopify: false, myshopifyDomain: null });
    expect(net.lookups).toEqual([]);
    expect(net.connections).toEqual([]);
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["cloud metadata", ["169.254.169.254"]],
    ["RFC1918", ["10.20.30.40"]],
    ["IPv6 unique-local", ["fd00::1"]],
    ["IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["mixed public + private answers (rebinding)", [PUBLIC_IP, "192.168.0.5"]],
  ])("refuses a hostname whose DNS answer is %s", async (_label, answers) => {
    net.dnsAnswers["store.attacker.example"] = answers;
    const response = await resolve("store.attacker.example");
    expect(await response.json()).toMatchObject({ isShopify: false, myshopifyDomain: null });
    expect(net.lookups.length).toBeGreaterThan(0); // it did check DNS…
    expect(net.connections).toEqual([]); // …and never connected
  });

  it("refuses a *.myshopify.com name that resolves to a private address", async () => {
    net.dnsAnswers["evil-store.myshopify.com"] = ["10.0.0.9"];
    const response = await resolve("evil-store.myshopify.com");
    expect(await response.json()).toMatchObject({ isShopify: false, myshopifyDomain: null });
    expect(net.connections).toEqual([]);
  });
});

describe("redirects are re-validated hop by hop", () => {
  it.each([
    ["a hostname that resolves privately", "https://internal.attacker.example/meta.json"],
    ["an IP literal", "https://169.254.169.254/latest/meta-data"],
    ["plain http", "http://shop.example.com/meta.json"],
    ["a non-default port", "https://shop.example.com:8443/meta.json"],
  ])("does not follow a redirect to %s", async (_label, location) => {
    net.dnsAnswers["shop.example.com"] = [PUBLIC_IP];
    net.dnsAnswers["internal.attacker.example"] = ["10.1.2.3"];
    net.sites["shop.example.com/meta.json"] = { status: 302, headers: { location } };
    net.sites["shop.example.com/"] = { status: 301, headers: { location } };

    const response = await resolve("shop.example.com");
    expect(await response.json()).toMatchObject({ isShopify: false, myshopifyDomain: null });
    // Only the public origin was contacted; the redirect target never was.
    expect(new Set(net.connections.map((c) => c.host))).toEqual(new Set(["shop.example.com"]));
    expect(net.connections.every((c) => c.address === PUBLIC_IP)).toBe(true);
  });

  it("stops after 3 redirects", async () => {
    net.dnsAnswers["loop.example.com"] = [PUBLIC_IP];
    net.sites["loop.example.com/meta.json"] = { status: 302, headers: { location: "/meta.json" } };
    net.sites["loop.example.com/"] = { status: 302, headers: { location: "/" } };
    const response = await resolve("loop.example.com");
    expect(await response.json()).toMatchObject({ isShopify: false });
    // 2 entry requests × (1 + 3 redirects) — bounded, then abandoned.
    expect(net.connections.length).toBe(8);
  });

  it("follows a safe public redirect and returns only a genuine *.myshopify.com domain", async () => {
    net.dnsAnswers["brand.example.com"] = [PUBLIC_IP];
    net.dnsAnswers["www.brand.example.com"] = [PUBLIC_IP];
    net.sites["brand.example.com/meta.json"] = {
      status: 301,
      headers: { location: "https://www.brand.example.com/meta.json" },
    };
    net.sites["www.brand.example.com/meta.json"] = {
      status: 200,
      body: JSON.stringify({ myshopify_domain: "brand-store.myshopify.com" }),
    };
    const response = await resolve("brand.example.com");
    expect(await response.json()).toEqual({ myshopifyDomain: "brand-store.myshopify.com", isShopify: true });
  });

  it("never returns a non-myshopify host taken from the remote response", async () => {
    net.dnsAnswers["brand.example.com"] = [PUBLIC_IP];
    net.sites["brand.example.com/meta.json"] = {
      status: 200,
      body: JSON.stringify({ myshopify_domain: "169.254.169.254" }),
    };
    net.sites["brand.example.com/"] = { status: 200, body: "<html>internal.myshopify.com.evil</html>" };
    const json = await (await resolve("brand.example.com")).json();
    expect(json.myshopifyDomain === null || /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(json.myshopifyDomain)).toBe(true);
    expect(json.myshopifyDomain).not.toBe("169.254.169.254");
  });
});
