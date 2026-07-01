export interface MediaDimensions {
  width: number;
  height: number;
  duration?: number;
}

/** True when the selected media (a local File or an already-uploaded URL) is a video. */
export function isVideoMedia(
  mediaFile: File | null,
  mediaCloudUrl: string,
): boolean {
  return (
    (mediaFile?.type.startsWith("video/") ?? false) ||
    mediaCloudUrl?.match(/\.(mp4|mov|webm)(\?|$)/i) !== null
  );
}

/**
 * Reads intrinsic dimensions (and duration, for video) from a local File using
 * an off-document <video>/<img> element. Rejects on unsupported/corrupt media,
 * or if metadata can't be read within 10s. Browser-only (uses document/Image).
 */
export function extractMediaDimensions(
  file: File,
  isVideoFile: boolean,
): Promise<MediaDimensions> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          "Media metadata extraction timed out. Please check if the file format/codec is supported.",
        ),
      );
    }, 10000);

    if (isVideoFile) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve({
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
        });
        URL.revokeObjectURL(video.src);
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            "Failed to load video metadata. Unsupported codec or corrupted file.",
          ),
        );
        URL.revokeObjectURL(video.src);
      };
      video.src = URL.createObjectURL(file);
    } else {
      const img = new window.Image();
      img.onload = () => {
        clearTimeout(timeout);
        resolve({ width: img.width, height: img.height });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            "Failed to load image. Unsupported format or corrupted file.",
          ),
        );
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    }
  });
}
