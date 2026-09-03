import { redirect } from 'next/navigation';

export default async function Home(props: {
  searchParams?: Promise<{ shop?: string }>;
}) {
  const params = await props.searchParams;
  if (params?.shop) {
    redirect(
      `/api/auth/shopify/connect?shop=${encodeURIComponent(params.shop)}&from=app_store`
    );
  }
  redirect('/dashboard');
}
