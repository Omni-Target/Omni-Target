import { auth } from "@clerk/nextjs/server";
import { updateUserIntegration } from "@/lib/db";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { meta_page_id, meta_page_name } = await request.json();

  await updateUserIntegration(userId, { 
    meta_page_id,
    meta_page_name
  });

  return Response.json({ success: true });
}
