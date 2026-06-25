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

  const { adAccountId } = await request.json();

  await updateUserIntegration(userId, { 
    meta_selected_account_id: adAccountId,
    meta_ad_account_id: adAccountId
  });

  return Response.json({ success: true });
}
