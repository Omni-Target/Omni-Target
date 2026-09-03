import Link from "next/link";
import { ArrowLeft, ArrowRight, ImageIcon, Sparkles, Wand2 } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { StoreInsights, StoreProduct } from "../types";

export interface InputStepProps {
  autoFilledFromStore: boolean;
  onBack: () => void;
  onChangeCreative: () => void;
  mediaPreviewUrl: string;
  mediaFile: File | null;
  productPrice: string;
  productVariants: string;
  storeInsights: StoreInsights | null;
  brandName: string;
  onBrandNameChange: (value: string) => void;
  productName: string;
  onProductNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  goal: string;
  onGoalChange: (value: string) => void;
  tone: string;
  onToneChange: (value: string) => void;
  errorMsg: string;
  showBuyCredits: boolean;
  onGenerate: () => void;
}

/** "Create a campaign brief" form step. */
export function InputStep({
  autoFilledFromStore,
  onBack,
  onChangeCreative,
  mediaPreviewUrl,
  mediaFile,
  productPrice,
  productVariants,
  storeInsights,
  brandName,
  onBrandNameChange,
  productName,
  onProductNameChange,
  description,
  onDescriptionChange,
  goal,
  onGoalChange,
  tone,
  onToneChange,
  errorMsg,
  showBuyCredits,
  onGenerate,
}: InputStepProps) {
  return (
    <div className="mx-auto max-w-2xl">
      <button
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {autoFilledFromStore ? "Change product / ad type" : "Back to creative"}
      </button>

      <div className="mb-6">
        <Badge variant="brand" className="mb-3">
          <Sparkles className="size-3" /> Campaign brief
        </Badge>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground sm:text-3xl">
          Create a campaign brief
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe your product. We&apos;ll generate ad copy and a complete
          targeting brief based on your store data.
        </p>
      </div>

      {autoFilledFromStore && (
        <Alert variant="success" className="mb-6">
          <p className="font-medium">
            Product loaded from your store. Review the details below.
          </p>
          <div className="mt-1 flex flex-wrap gap-4 text-current/80">
            {productPrice && (
              <span>
                Price:{" "}
                {formatCurrency(
                  parseFloat(productPrice),
                  storeInsights?.store?.currency || "USD",
                )}
              </span>
            )}
            {productVariants && (
              <span>
                Variants: {productVariants.split(",").slice(0, 3).join(", ")}
              </span>
            )}
          </div>
        </Alert>
      )}

      {/* Creative summary */}
      <Card className="mb-6 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint-foreground">
          Ad creative
        </p>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            {mediaPreviewUrl ? (
              <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-muted ring-1 ring-border-subtle">
                {mediaFile?.type?.startsWith("video/") ||
                mediaPreviewUrl.includes(".mp4") ||
                mediaPreviewUrl.includes(".mov") ? (
                  <ImageIcon className="size-5 text-brand-500" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={mediaPreviewUrl}
                    alt="Ad creative"
                    className="size-full object-cover"
                  />
                )}
              </div>
            ) : (
              <div className="grid size-16 shrink-0 place-items-center rounded-xl border border-dashed border-border text-faint-foreground">
                <ImageIcon className="size-5" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {mediaFile
                    ? "Custom creative uploaded"
                    : autoFilledFromStore
                      ? "Shopify catalog image"
                      : "Custom ad creative"}
                </span>
                {mediaFile && (
                  <Badge variant="brand" size="sm">
                    Custom
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-subtle-foreground">
                {mediaFile
                  ? mediaFile.type.startsWith("video/")
                    ? "Custom video ad file"
                    : "Custom image file"
                  : autoFilledFromStore
                    ? "Automatically synced from Shopify catalog"
                    : "Upload an image or video for this campaign"}
              </p>
            </div>
          </div>
          <Button
            variant="subtle"
            size="sm"
            onClick={onChangeCreative}
            className="shrink-0"
          >
            {autoFilledFromStore && !mediaFile
              ? "Use custom upload"
              : "Change creative"}
          </Button>
        </div>
      </Card>

      <div className="space-y-5">
        <Field
          label={
            <>
              Brand name <span className="text-danger-500">*</span>
            </>
          }
          htmlFor="brandName"
        >
          <Input
            id="brandName"
            value={brandName}
            onChange={(e) => onBrandNameChange(e.target.value)}
            placeholder="Your Brand"
          />
        </Field>

        <Field
          label={
            <>
              Product name <span className="text-danger-500">*</span>
            </>
          }
          htmlFor="productName"
        >
          <Input
            id="productName"
            list="store-products-list"
            value={productName}
            onChange={(e) => onProductNameChange(e.target.value)}
            placeholder="e.g. Adire Maxi Dress"
          />
          {storeInsights?.products && storeInsights.products.length > 0 && (
            <datalist id="store-products-list">
              {storeInsights.products.map((p: StoreProduct) => (
                <option key={String(p.id)} value={p.name} />
              ))}
            </datalist>
          )}
        </Field>

        <Field
          label={
            <>
              Product description <span className="text-danger-500">*</span>
            </>
          }
          htmlFor="description"
        >
          <Textarea
            id="description"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Describe what makes this product special — material, craft, story, feeling"
            rows={3}
          />
        </Field>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Campaign goal" htmlFor="goal">
            <Select
              id="goal"
              value={goal}
              onChange={(e) => onGoalChange(e.target.value)}
            >
              <option>Drive Website Sales</option>
              <option>Grow Brand Awareness</option>
              <option>Promote a New Collection</option>
              <option>Retarget Past Visitors</option>
            </Select>
          </Field>
          <Field label="Tone preference" htmlFor="tone">
            <Select
              id="tone"
              value={tone}
              onChange={(e) => onToneChange(e.target.value)}
            >
              <option>Let AI decide (recommended)</option>
              <option>Premium &amp; Aspirational</option>
              <option>Bold &amp; Direct</option>
              <option>Warm &amp; Conversational</option>
              <option>Minimal &amp; Editorial</option>
            </Select>
          </Field>
        </div>
      </div>

      {errorMsg && (
        <div className="mt-5 space-y-3">
          <Alert variant="danger">{errorMsg}</Alert>
          {showBuyCredits && (
            <div className="text-center">
              <Button asChild>
                <Link href="/pricing">
                  Buy credits <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}

      <Button size="xl" className="mt-8 w-full" onClick={onGenerate}>
        <Wand2 className="size-4" />
        Generate ad copy &amp; hooks
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}
