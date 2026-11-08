import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { getUserIntegration } from "@/lib/db";
import { generateRecommendations } from "@/lib/insights-engine";
import { retiredEndpointResponse } from "@/lib/api/retired-endpoint";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  // SEC-08: uncharged LLM endpoint with no in-app callers — retired by default.
  const retired = retiredEndpointResponse("/api/store/insights", request, userId);
  if (retired) return retired;

  const limited = await enforceRateLimit({
    action: "store:insights",
    identifier: userId,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!limited.ok) return limited.response;

  try {
    // Get cached store snapshot
    const integration = await getUserIntegration(userId);

    if (!integration?.store_snapshot) {
      return Response.json({
        error: "No store data available. Sync your store first.",
      }, { status: 400 });
    }

    const recommendations = await generateRecommendations(
      integration.store_snapshot,
      undefined,
      userId
    );

    return Response.json(recommendations);
  } catch (error) {
    console.error("Insights generation error:", error);
    return Response.json(
      { error: "Failed to generate insights" },
      { status: 500 }
    );
  }
}
