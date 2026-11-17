import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getBriefVersions, getCampaign, tenantFor } from "@/modules/campaigns/repository";
import { PageContainer } from "@/components/layout/page-container";
import { BriefView } from "./brief-view";

/**
 * Stable, shareable home for a generated brief. Replaces the old ephemeral
 * "open the PDF in a new tab" flow: the campaign is loaded from the DB (scoped
 * to its owner) so it survives refresh and can be revisited from history.
 */
export default async function CampaignBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { id } = await params;
  const { version } = await searchParams;
  const { userId } = await auth();
  if (!userId) notFound();

  const tenant = await tenantFor(userId);
  if (!tenant) notFound();
  const campaign = await getCampaign(tenant, id);
  if (!campaign) notFound();

  // The retained regeneration attempts, so the user can review the alternatives
  // and switch which one is their selected brief.
  const versions = await getBriefVersions(tenant, id);

  return (
    <PageContainer width="wide" className="pb-24 lg:pb-12">
      <BriefView campaign={campaign} versions={versions} initialVersionId={typeof version === "string" ? version : null} />
    </PageContainer>
  );
}
