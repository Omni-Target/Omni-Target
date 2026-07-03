import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getCampaignById, getBriefVersions } from "@/lib/db";
import { PageContainer } from "@/components/layout/page-container";
import { BriefView } from "./brief-view";

/**
 * Stable, shareable home for a generated brief. Replaces the old ephemeral
 * "open the PDF in a new tab" flow: the campaign is loaded from the DB (scoped
 * to its owner) so it survives refresh and can be revisited from history.
 */
export default async function CampaignBriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) notFound();

  const campaign = await getCampaignById(userId, id);
  if (!campaign) notFound();

  // The retained regeneration attempts, so the user can review the alternatives
  // and switch which one is their selected brief.
  const versions = await getBriefVersions(userId, id);

  return (
    <PageContainer width="wide" className="pb-24 lg:pb-12">
      <BriefView campaign={campaign} versions={versions} />
    </PageContainer>
  );
}
