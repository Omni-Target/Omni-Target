import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry } from "./http";

const res = (status: number) => new Response("{}", { status });

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithRetry", () => {
  it("returns immediately on 2xx (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchWithRetry("https://x", {}, { retries: 2 });

    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx (client error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(404));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchWithRetry("https://x", {}, { retries: 2 });

    expect(out.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 500 then returns the eventual 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchWithRetry("https://x", {}, { retries: 2 });

    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the final 5xx after exhausting retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(503));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchWithRetry("https://x", {}, { retries: 2 });

    expect(out.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("aborts a hung request after the timeout and rejects", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://x", {}, { retries: 0, timeoutMs: 20 }),
    ).rejects.toThrow();
  });
});
