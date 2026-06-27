"use client";

import {
  ThumbsUp,
  MessageCircle,
  Share2,
  Heart,
  Send,
  Bookmark,
  MoreHorizontal,
  ImageIcon,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GeneratedCopy } from "./types";

export function AdPreview({
  platform,
  onPlatformChange,
  brandName,
  mediaCloudUrl,
  isVideo,
  copy,
  selectedCta,
  storeDomain,
}: {
  platform: "facebook" | "instagram";
  onPlatformChange: (p: "facebook" | "instagram") => void;
  brandName: string;
  mediaCloudUrl: string;
  isVideo: boolean;
  copy: GeneratedCopy;
  selectedCta: string;
  storeDomain: string;
}) {
  const cta = selectedCta || copy.cta;
  const brand = brandName || "Your Brand";

  const renderMedia = (ratio: string) =>
    mediaCloudUrl ? (
      isVideo ? (
        <video src={mediaCloudUrl} className={cn("w-full object-cover", ratio)} muted playsInline />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaCloudUrl} alt="Ad creative" className={cn("w-full object-cover", ratio)} />
      )
    ) : (
      <div className={cn("flex w-full flex-col items-center justify-center gap-2 bg-slate-100", ratio)}>
        <ImageIcon className="size-8 text-slate-300" />
        <span className="text-xs text-slate-400">No creative uploaded</span>
      </div>
    );

  return (
    <div className="flex flex-col items-center">
      <div className="mb-5 inline-flex rounded-lg border border-border-subtle bg-surface-subtle p-1">
        <button
          onClick={() => onPlatformChange("facebook")}
          className={cn(
            "rounded-md px-4 py-1.5 text-xs font-semibold transition-all",
            platform === "facebook"
              ? "bg-[#1877F2] text-white shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Facebook
        </button>
        <button
          onClick={() => onPlatformChange("instagram")}
          className={cn(
            "rounded-md px-4 py-1.5 text-xs font-semibold transition-all",
            platform === "instagram"
              ? "bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Instagram
        </button>
      </div>

      {platform === "facebook" ? (
        <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-black/10 bg-white font-sans text-black/90 shadow-lg">
          <div className="flex items-center justify-between p-3">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-full bg-slate-200 font-bold uppercase text-slate-500">
                {brand.slice(0, 2)}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold">{brand}</span>
                <span className="text-[11px] text-black/50">Sponsored</span>
              </div>
            </div>
            <MoreHorizontal className="size-5 text-black/40" />
          </div>
          {renderMedia("aspect-square border-y border-black/5")}
          <div className="p-3">
            <p className="mb-3 line-clamp-3 text-[13.5px] leading-snug text-black">
              {copy.primaryText}
            </p>
            <div className="-mx-3 mb-1 border-t border-black/5 bg-[#f0f2f5] p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="mb-1 truncate text-[11px] uppercase tracking-widest text-black/50">
                    {storeDomain.toUpperCase()}
                  </p>
                  <h4 className="mb-0.5 truncate text-[15px] font-semibold leading-tight text-black">
                    {copy.headline}
                  </h4>
                  <p className="truncate text-[13px] text-black/50">{copy.description}</p>
                </div>
                <span className="shrink-0 rounded border border-black/5 bg-black/10 px-4 py-1.5 text-[13px] font-semibold text-black">
                  {cta}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-black/5 px-3 pb-3 pt-3 text-black/60">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <ThumbsUp className="size-5" /> Like
            </span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <MessageCircle className="size-5" /> Comment
            </span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Share2 className="size-5" /> Share
            </span>
          </div>
        </div>
      ) : (
        <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-black/10 bg-white font-sans text-black/90 shadow-lg">
          <div className="flex items-center justify-between border-b border-black/5 p-3">
            <div className="flex items-center gap-3">
              <div className="grid size-8 place-items-center rounded-full bg-slate-200 text-xs font-bold uppercase text-slate-500">
                {brand.slice(0, 2)}
              </div>
              <div className="flex flex-col">
                <span className="text-[13px] font-semibold tracking-tight">{brand}</span>
                <span className="text-[11px] font-normal text-black/50">Sponsored</span>
              </div>
            </div>
            <MoreHorizontal className="size-5 text-black/60" />
          </div>
          {renderMedia("aspect-[4/5]")}
          <div className="flex cursor-pointer items-center justify-between bg-[#3897f0] px-4 py-3">
            <span className="text-[13px] font-semibold text-white">{cta}</span>
            <ChevronRight className="size-4 text-white" />
          </div>
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between text-black/80">
              <div className="flex items-center gap-4">
                <Heart className="size-6" />
                <MessageCircle className="size-6" />
                <Send className="size-6" />
              </div>
              <Bookmark className="size-6" />
            </div>
            <p className="mb-1 text-[13px] font-semibold text-black">1,234 likes</p>
            <p className="line-clamp-3 text-[13.5px] leading-snug text-black">
              <span className="mr-1.5 font-semibold">{brand}</span>
              {copy.primaryText}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
