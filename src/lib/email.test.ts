import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.RESEND_API_KEY = "re_test";
  return { send: vi.fn(), claim: vi.fn(), release: vi.fn() };
});
vi.mock("resend", () => ({ Resend: class { emails = { send: h.send }; } }));
vi.mock("@/modules/notifications/email-log", () => ({ claimEmailSend: h.claim, releaseEmailClaim: h.release }));

import { sendEmail } from "./email";

const nudge = { to: "a@example.com", subject: "S", html: "<p>h</p>", userId: "user_1", templateName: "brief-nudge" };

describe("sendEmail claims before sending (DATA-07)", () => {
  beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("claims the send for a week, then sends and keeps the claim", async () => {
    h.claim.mockResolvedValue("claim-1");
    h.send.mockResolvedValue({ data: { id: "m1" }, error: null });
    await expect(sendEmail(nudge)).resolves.toMatchObject({ success: true });
    expect(h.claim).toHaveBeenCalledWith("user_1", "brief-nudge", 7);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("skips a template already sent or claimed within the week", async () => {
    h.claim.mockResolvedValue(null);
    await expect(sendEmail(nudge)).resolves.toEqual({ success: true, skipped: true });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("gives the claim back when the send fails, so the next run retries", async () => {
    h.claim.mockResolvedValue("claim-2");
    h.send.mockResolvedValueOnce({ data: null, error: { message: "rejected" } }).mockRejectedValueOnce(new Error("network"));
    await expect(sendEmail(nudge)).resolves.toMatchObject({ success: false });
    await expect(sendEmail(nudge)).resolves.toMatchObject({ success: false });
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledWith("claim-2");
  });

  it("sends nothing when the send log cannot be reached", async () => {
    h.claim.mockRejectedValue(new Error("Email log unavailable"));
    await expect(sendEmail(nudge)).resolves.toEqual({ success: false, error: "email_log_unavailable" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("sends an email that is not tied to a user without claiming", async () => {
    h.send.mockResolvedValue({ data: { id: "m2" }, error: null });
    await expect(sendEmail({ to: "a@example.com", subject: "S", html: "x" })).resolves.toMatchObject({ success: true });
    expect(h.claim).not.toHaveBeenCalled();
  });
});
