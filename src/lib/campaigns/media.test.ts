import { describe, it, expect } from "vitest";
import { isVideoMedia } from "@/lib/campaigns/media";

describe("isVideoMedia", () => {
  it("detects a video by file MIME type", () => {
    const file = new File([], "clip.mp4", { type: "video/mp4" });
    expect(isVideoMedia(file, "")).toBe(true);
  });

  it("treats an image file as non-video", () => {
    const file = new File([], "pic.png", { type: "image/png" });
    expect(isVideoMedia(file, "")).toBe(false);
  });

  it("detects a video by URL extension, with or without a query string", () => {
    expect(isVideoMedia(null, "https://cdn.example.com/a.mp4")).toBe(true);
    expect(isVideoMedia(null, "https://cdn.example.com/a.mov?token=123")).toBe(
      true,
    );
    expect(isVideoMedia(null, "https://cdn.example.com/a.webm")).toBe(true);
  });

  it("returns false for an image URL and for empty input", () => {
    expect(isVideoMedia(null, "https://cdn.example.com/a.jpg")).toBe(false);
    expect(isVideoMedia(null, "")).toBe(false);
  });
});
