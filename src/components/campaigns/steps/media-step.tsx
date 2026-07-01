import type * as React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MediaValidationResult } from "@/lib/meta-specs";
import { MediaDropzone } from "../media-dropzone";

export interface MediaStepProps {
  autoFilledFromStore: boolean;
  onBack: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isUploading: boolean;
  mediaPreviewUrl: string;
  mediaFile: File | null;
  mediaCloudUrl: string;
  uploadError: string;
  mediaValidation: MediaValidationResult | null;
  onContinue: () => void;
}

/** "Upload ad creative" step. */
export function MediaStep({
  autoFilledFromStore,
  onBack,
  fileInputRef,
  onFileChange,
  isUploading,
  mediaPreviewUrl,
  mediaFile,
  mediaCloudUrl,
  uploadError,
  mediaValidation,
  onContinue,
}: MediaStepProps) {
  return (
    <div className="mx-auto max-w-2xl">
      <button
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {autoFilledFromStore
          ? "Back to campaign details (keep catalog image)"
          : "Back to options"}
      </button>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Upload ad creative
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Start by uploading your image or video. We&apos;ll validate it against
          Meta&apos;s ad specs automatically.
        </p>
      </div>

      <MediaDropzone
        inputRef={fileInputRef}
        onFileChange={onFileChange}
        isUploading={isUploading}
        mediaPreviewUrl={mediaPreviewUrl}
        mediaFile={mediaFile}
        autoFilledFromStore={autoFilledFromStore}
        uploadError={uploadError}
        mediaValidation={mediaValidation}
      />

      <div className="mt-8 flex flex-col gap-3">
        <Button
          size="lg"
          onClick={onContinue}
          disabled={
            isUploading ||
            !mediaCloudUrl ||
            (mediaValidation ? !mediaValidation.isValid : false)
          }
        >
          Continue to ad copy
          <ArrowRight className="size-4" />
        </Button>
        <button
          onClick={onContinue}
          className="text-center text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip for now — add creative later
        </button>
      </div>
    </div>
  );
}
