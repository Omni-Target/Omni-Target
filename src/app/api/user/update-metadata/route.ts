import { auth, clerkClient } from "@clerk/nextjs/server";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json();

  const client = await clerkClient();  // ← await it as a function
  await client.users.updateUserMetadata(
    userId,
    { publicMetadata: body }
  );

  return Response.json({ success: true });
}
