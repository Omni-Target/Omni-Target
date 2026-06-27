"use client";

import * as React from "react";
import { UploadCloud } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Alert } from "@/components/ui/alert";
import type { MediaValidationResult } from "@/lib/meta-specs";

export function MediaDropzone({
  inputRef,
  onFileChange,
  isUploading,
  mediaPreviewUrl,
  mediaFile,
  autoFilledFromStore,
  uploadError,
  mediaValidation,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isUploading: boolean;
  mediaPreviewUrl: string;
  mediaFile: File | null;
  autoFilledFromStore: boolean;
  uploadError: string;
  mediaValidation: MediaValidationResult | null;
}) {
  const isVideoFile = mediaFile?.type?.startsWith("video/");

  return (
    <div className="space-y-4">
      <div
        onClick={() => inputRef.current?.click()}
        className="group relative flex min-h-[300px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-surface-subtle p-6 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
      >
        <input
          type="file"
          ref={inputRef}
          accept="image/jpeg,image/png,video/mp4,video/quicktime"
          onChange={onFileChange}
          className="hidden"
          disabled={isUploading}
        />

        {isUploading ? (
          <div className="flex flex-col items-center gap-3">
            <Spinner size="lg" />
            <p className="text-sm font-medium text-muted-foreground">Uploading…</p>
          </div>
        ) : mediaPreviewUrl ? (
          <div className="flex w-full flex-col items-center">
            {autoFilledFromStore && (
              <div className="mb-4">
                <p className="text-sm font-medium text-foreground">Using store product image</p>
                <p className="mt-1 text-xs text-brand-600">
                  Got a custom video ad instead? Click below to upload it.
                </p>
              </div>
            )}
            <div className="relative mb-4 flex aspect-square w-full max-w-sm items-center justify-center overflow-hidden rounded-xl bg-slate-100 sm:aspect-square">
              {isVideoFile ? (
                <video
                  src={mediaPreviewUrl}
                  controls
                  className="max-h-full max-w-full object-contain"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaPreviewUrl} alt="Preview" className="max-h-full max-w-full object-contain" />
              )}
            </div>
            <span className="rounded-lg bg-surface px-4 py-2 text-xs font-semibold text-foreground shadow-xs ring-1 ring-border">
              {autoFilledFromStore ? "Upload custom creative (video/image)" : "Change media"}
            </span>
          </div>
        ) : (
          <div className="pointer-events-none flex flex-col items-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-surface text-brand-600 shadow-xs">
              <UploadCloud className="size-6" />
            </div>
            <p className="mt-4 text-base font-semibold text-foreground">
              Upload your ad creative
            </p>
            <p className="mt-1 text-xs text-subtle-foreground">
              JPG, PNG, MP4 or MOV · Images min 1080px · Videos max 45s
            </p>
          </div>
        )}
      </div>

      {uploadError && <Alert variant="danger">{uploadError}</Alert>}

      {mediaValidation && (
        <div className="space-y-2">
          {mediaValidation.errors.length === 0 && mediaValidation.warnings.length === 0 && (
            <Alert variant="success">Creative looks great for Meta</Alert>
          )}
          {mediaValidation.errors.map((err, i) => (
            <Alert key={`err-${i}`} variant="danger">
              {err}
            </Alert>
          ))}
          {mediaValidation.warnings.map((warn, i) => (
            <Alert key={`warn-${i}`} variant="warning">
              {warn}
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}
