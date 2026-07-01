import { PageContainer } from "@/components/layout/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <Skeleton className="hidden h-64 w-full rounded-2xl lg:block" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    </PageContainer>
  );
}
