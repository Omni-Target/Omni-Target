import { NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function POST(request: Request) {
  try {
    const { filename, contentType } = await request.json();

    if (!filename || !contentType) {
      return NextResponse.json({ error: "Filename and contentType are required" }, { status: 400 });
    }

    const objectKey = `uploads/${Date.now()}-${filename}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    
    // Combine with the public URL
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${objectKey}`;

    return NextResponse.json({ presignedUrl, objectKey, publicUrl });
  } catch (error: any) {
    console.error("Presigned URL generation error:", error);
    return NextResponse.json({ error: error.message || "Failed to generate presigned URL" }, { status: 500 });
  }
}
