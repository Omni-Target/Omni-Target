import { NextResponse } from "next/server";
import cloudinary from "@/lib/cloudinary";

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png", 
  "video/mp4",
  "video/quicktime"
];

const MAX_VIDEO_SIZE = 4 * 1024 * 1024 * 1024; // 4GB
const MAX_IMAGE_SIZE = 30 * 1024 * 1024; // 30MB

/**
 * Interface for expected Cloudinary upload result
 */
interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  resource_type: string;
  width: number;
  height: number;
  duration?: number;
  format: string;
}

/**
 * POST handler for file uploads to Cloudinary
 * @param request The incoming HTTP request containing the FormData with a "file" field
 * @returns JSON response with uploaded file details or an error object
 */
export async function POST(request: Request) {
  try {
    // 1. Read the file from the request
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided." },
        { status: 400 }
      );
    }

    // 2. Validate the file before uploading
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Unsupported file type. \n  Please upload JPG, PNG, MP4 or MOV." },
        { status: 400 }
      );
    }

    const isVideo = file.type.startsWith("video/");

    if (isVideo && file.size > MAX_VIDEO_SIZE) {
      return NextResponse.json(
        { error: "Video must be under 4GB." },
        { status: 400 }
      );
    }

    if (!isVideo && file.size > MAX_IMAGE_SIZE) {
      return NextResponse.json(
        { error: "Image must be under 30MB." },
        { status: 400 }
      );
    }

    // 3. Convert file to buffer and upload to Cloudinary
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const result = await new Promise<CloudinaryUploadResult>((resolve, reject) => {
      const uploadOptions: any = {
        resource_type: isVideo ? "video" : "image",
        folder: "omni-target/campaigns",
      };
      
      if (!isVideo) {
        uploadOptions.transformation = [
          { quality: "auto" },
          { fetch_format: "auto" }
        ];
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) reject(error);
          else resolve(result as CloudinaryUploadResult);
        }
      );
      uploadStream.end(buffer);
    });

    // 4. Return the Cloudinary response
    return NextResponse.json({
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      width: result.width,
      height: result.height,
      duration: result.duration || null,
      format: result.format
    }, { status: 200 });

  } catch (error: any) {
    console.error("Cloudinary upload error:", error);
    // 5. Wrap everything in try/catch and return actual error if possible
    return NextResponse.json(
      { error: error?.message || error?.error?.message || "Upload failed. Please try again." },
      { status: 500 }
    );
  }
}
