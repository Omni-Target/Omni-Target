import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import type { MediaValidationResult } from "@/lib/meta-specs";
import { extractMediaDimensions, isVideoMedia } from "@/lib/campaigns/media";

export interface UseMediaUploadResult {
  fileInputRef: RefObject<HTMLInputElement | null>;
  mediaFile: File | null;
  mediaPreviewUrl: string;
  mediaCloudUrl: string;
  mediaValidation: MediaValidationResult | null;
  isUploading: boolean;
  uploadError: string;
  isVideo: boolean;
  handleMediaSelect: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  applyDraftImage: (imageUrl: string) => void;
  resetMedia: () => void;
}

/**
 * Owns ad-creative state and the upload pipeline (presign → PUT → dimension
 * read → Meta spec validation), plus the derived `isVideo` flag.
 *
 * The flow/draft layer drives media state only through the semantic
 * `applyDraftImage` / `resetMedia` methods — never raw setters — so it can
 * never be left half-updated from outside. Both methods (and the change
 * handler) are stable, so callers may safely list them in effect deps.
 */
export function useMediaUpload(): UseMediaUploadResult {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>("");
  const [mediaCloudUrl, setMediaCloudUrl] = useState<string>("");
  const [mediaValidation, setMediaValidation] =
    useState<MediaValidationResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const isVideo = isVideoMedia(mediaFile, mediaCloudUrl);

  const handleMediaSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setMediaFile(file);
      setUploadError("");
      setMediaValidation(null);

      const localUrl = URL.createObjectURL(file);
      setMediaPreviewUrl(localUrl);

      const isVideoFile = file.type.startsWith("video/");

      setIsUploading(true);
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type }),
        });

        if (!res.ok) {
          const err = await res.json();
          setUploadError(
            err.error || "Failed to get upload URL. Please try again.",
          );
          setMediaFile(null);
          setMediaPreviewUrl("");
          return;
        }

        const { presignedUrl, publicUrl } = await res.json();

        const uploadRes = await fetch(presignedUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });

        if (!uploadRes.ok) {
          setUploadError("Failed to upload file. Please try again.");
          setMediaFile(null);
          setMediaPreviewUrl("");
          return;
        }

        setMediaCloudUrl(publicUrl);

        const dimensions = await extractMediaDimensions(file, isVideoFile);
        const { validateMetaAdMedia } = await import("@/lib/meta-specs");
        const validation = validateMetaAdMedia({
          width: dimensions.width,
          height: dimensions.height,
          duration: dimensions.duration,
          format: file.type.split("/")[1],
          resourceType: isVideoFile ? "video" : "image",
        });
        setMediaValidation(validation);
      } catch (err) {
        setUploadError(
          err instanceof Error
            ? err.message
            : "Upload failed. Please try again.",
        );
        setMediaFile(null);
        setMediaPreviewUrl("");
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  const applyDraftImage = useCallback((imageUrl: string) => {
    setMediaPreviewUrl(imageUrl);
    setMediaCloudUrl(imageUrl);
  }, []);

  const resetMedia = useCallback(() => {
    setMediaPreviewUrl("");
    setMediaCloudUrl("");
    setMediaFile(null);
    setMediaValidation(null);
  }, []);

  return {
    fileInputRef,
    mediaFile,
    mediaPreviewUrl,
    mediaCloudUrl,
    mediaValidation,
    isUploading,
    uploadError,
    isVideo,
    handleMediaSelect,
    applyDraftImage,
    resetMedia,
  };
}
