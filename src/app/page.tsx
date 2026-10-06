import { redirect } from 'next/navigation';

export default async function Home(props: {
  searchParams?: Promise<{ shop?: string; plan?: string }>;
}) {
  const params = await props.searchParams;
  if (params?.shop) {
    const planQuery = params.plan ? `&plan=${encodeURIComponent(params.plan)}` : "";
    redirect(
      `/api/auth/shopify/connect?shop=${encodeURIComponent(params.shop)}&from=app_store${planQuery}`
    );
  }
  if (params?.plan) {
    redirect(`/dashboard?plan=${encodeURIComponent(params.plan)}`);
  }
  redirect('/dashboard');
}
