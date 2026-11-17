import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ candidates: vi.fn(), getUserList: vi.fn(), send: vi.fn(), failure: vi.fn() }));
vi.mock("@/modules/notifications/email-log", () => ({ briefNudgeCandidates: h.candidates }));
vi.mock("@/lib/email", () => ({ sendEmail: h.send }));
vi.mock("@/lib/observability/capture", () => ({ captureBackgroundFailure: h.failure }));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUserList: h.getUserList } }) }));

import { GET } from "./route";

const call = (auth = "Bearer cron-secret") => GET(new Request("https://app.test/api/cron/brief-nudge", { headers: { authorization: auth } }));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `user_${i}`);
const usersFor = (list: string[]) => ({ data: list.map((id, i) => ({ id, emailAddresses: i % 10 === 9 ? [] : [{ emailAddress: `${id}@example.com` }] })) });

describe("GET /api/cron/brief-nudge (DATA-07)", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    for (const fn of Object.values(h)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.getUserList.mockImplementation(async ({ userId }: { userId: string[] }) => usersFor(userId));
    h.send.mockResolvedValue({ success: true });
  });

  it("refuses without the cron secret", async () => {
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(h.candidates).not.toHaveBeenCalled();
  });

  it("finds candidates in one query and looks them up in Clerk 100 at a time", async () => {
    h.candidates.mockResolvedValue(ids(150));
    const body = await (await call()).json();
    expect(h.candidates).toHaveBeenCalledTimes(1);
    expect(h.candidates.mock.calls[0][1]).toBe(200);
    expect(Date.now() - h.candidates.mock.calls[0][0].getTime()).toBeGreaterThanOrEqual(48 * 3600 * 1000 - 1000);
    expect(h.getUserList).toHaveBeenCalledTimes(2);
    expect(h.getUserList.mock.calls.map(([p]) => p.userId.length)).toEqual([100, 50]);
    // Every tenth user has no email address.
    expect(body).toEqual({ success: true, processed: 150, sent: 135 });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_0", templateName: "brief-nudge", to: "user_0@example.com" }));
  });

  it("counts only emails actually sent, and keeps going when one lookup batch fails", async () => {
    h.candidates.mockResolvedValue(ids(120));
    h.getUserList.mockRejectedValueOnce(new Error("clerk down"));
    h.send.mockResolvedValueOnce({ success: true, skipped: true });
    const body = await (await call()).json();
    expect(h.failure).toHaveBeenCalledWith("cron-brief-nudge-lookup", expect.any(Error));
    expect(body).toMatchObject({ processed: 120, sent: 17 });
  });

  it("returns a generic error when candidates cannot be listed", async () => {
    h.candidates.mockRejectedValue(new Error("connection string leaked"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("leaked");
  });
});
