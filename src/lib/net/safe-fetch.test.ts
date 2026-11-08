import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { SafeFetchError, assertSafeUrl, createSafeLookup, isPublicIpAddress, safeFetch } from "./safe-fetch";

describe("isPublicIpAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1", // hex-form IPv4-mapped loopback
    "64:ff9b::7f00:1", // NAT64 to loopback
    "2002:7f00:1::", // 6to4 of loopback
    "2001:db8::1",
    "not-an-ip",
  ])("rejects non-public %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "23.227.38.65", "::ffff:8.8.8.8", "::ffff:808:808", "2606:4700:4700::1111"])("accepts public %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });
});

describe("createSafeLookup (connection-time DNS validation)", () => {
  const fakeResolver = (answers: LookupAddress[] | Error) =>
    ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => {
      if (answers instanceof Error) cb(answers as NodeJS.ErrnoException, []);
      else cb(null, answers);
    }) as unknown as Parameters<typeof createSafeLookup>[0];

  const run = (answers: LookupAddress[] | Error, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      createSafeLookup(fakeResolver(answers))("shop.example", { all }, (err, address) => resolve({ err, address }));
    });

  it("passes through all-public answers (single and all forms)", async () => {
    expect(await run([{ address: "23.227.38.65", family: 4 }])).toEqual({ err: null, address: "23.227.38.65" });
    const all = await run([{ address: "23.227.38.65", family: 4 }], true);
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: "23.227.38.65", family: 4 }]);
  });

  it("refuses a hostname with ANY non-public answer (rebinding-style mixed records)", async () => {
    const mixed = await run([
      { address: "23.227.38.65", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    expect(mixed.err?.code).toBe("EBLOCKED");
    expect((await run([{ address: "127.0.0.1", family: 4 }])).err?.code).toBe("EBLOCKED");
    expect((await run([{ address: "::1", family: 6 }])).err?.code).toBe("EBLOCKED");
    expect((await run([])).err?.code).toBe("EBLOCKED");
  });

  it("propagates resolver errors", async () => {
    const err = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    expect((await run(err)).err?.code).toBe("ENOTFOUND");
  });
});

describe("assertSafeUrl", () => {
  it.each([
    ["http://shop.example/", "invalid_url"],
    ["https://shop.example:8443/", "invalid_url"],
    ["https://user:pass@shop.example/", "invalid_url"],
    ["https://127.0.0.1/", "blocked_destination"],
    ["https://[::1]/", "blocked_destination"],
    ["https://localhost/", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["not a url", "invalid_url"],
  ])("rejects %s (%s)", (url, code) => {
    try {
      assertSafeUrl(url);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(SafeFetchError);
      expect((err as SafeFetchError).code).toBe(code);
    }
  });

  it("accepts an https URL on the default port", () => {
    expect(assertSafeUrl("https://brand.com/meta.json").hostname).toBe("brand.com");
  });

  it("safeFetch refuses IP-literal destinations before any network activity", async () => {
    await expect(safeFetch("https://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "blocked_destination" });
  });
});
