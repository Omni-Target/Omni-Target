export interface MediaValidationResult {
  isValid: boolean;
  errors: string[];   // Blockers — ad cannot launch
  warnings: string[]; // Suggestions — ad can still launch
}

export function validateMetaAdMedia(params: {
  width?: number;
  height?: number;
  duration?: number; // seconds, for video
  format: string;
  resourceType: "image" | "video";
  platform?: "facebook" | "instagram" | "both" | "stories";
}): MediaValidationResult {
  const result: MediaValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  };

  const { width, height, duration, resourceType, platform } = params;

  if (resourceType === "image") {
    // Check dimensions
    if ((width !== undefined && width < 600) || (height !== undefined && height < 600)) {
      result.errors.push("Image is too small for Meta ads. Minimum size is 600x600px.");
    } else if ((width !== undefined && width < 1080) || (height !== undefined && height < 1080)) {
      result.warnings.push("For best quality, use images at least 1080px wide. Smaller images may appear slightly soft on retina screens.");
    }

    // Check ideal aspect ratios
    if (width !== undefined && height !== undefined && height > 0) {
      const aspectRatio = width / height;
      const targetRatios = [
        1.0,         // 1:1
        0.8,         // 4:5
        0.5625,      // 9:16
        1.91         // 1.91:1
      ];

      // Match within 5% tolerance
      const hasValidRatio = targetRatios.some(
        ratio => Math.abs(aspectRatio - ratio) / ratio <= 0.05
      );

      if (!hasValidRatio) {
        result.warnings.push("Aspect ratio may be cropped by Meta. Best ratios: 1:1, 4:5, or 9:16.");
      }
    }
  } else if (resourceType === "video") {
    if (duration !== undefined) {
      // Check limits
      if (duration > 45) {
        result.errors.push("Video exceeds 45 seconds. Meta Feed ads perform best when punchy and under 45s.");
      } else if (duration < 1) {
        result.errors.push("Video is too short.");
      }

      // Check recommendation
      if (duration > 15 && duration <= 45) {
        result.warnings.push("Videos under 15 seconds typically get higher completion rates on Meta feeds.");
      }
    }
  }

  // Check stories platform requirement for both image and video
  if (platform === "stories" && width !== undefined && height !== undefined && height > 0) {
    const aspectRatio = width / height;
    const is9by16 = Math.abs(aspectRatio - 0.5625) / 0.5625 <= 0.05;
    if (!is9by16) {
      result.warnings.push("Stories ads perform best at 9:16 (1080x1920px). Your current ratio may be cropped.");
    }
  }

  if (result.errors.length > 0) {
    result.isValid = false;
  }

  return result;
}
