import { getPackById } from "@/lib/credit-packs";
import { grantCredits } from "@/lib/grant-credits";

export async function GET(
  request: Request
) {
  const { searchParams } =
    new URL(request.url);
  const reference =
    searchParams.get("reference");

  if (!reference) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/pricing?status=failed`
    );
  }

  // Verify with Paystack
  const verifyRes = await fetch(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${process.env
          .PAYSTACK_SECRET_KEY}`,
      },
    }
  );

  const verifyData = await verifyRes.json();

  if (verifyData.data?.status !== "success") {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/pricing?status=failed`
    );
  }

  const metadata =
    verifyData.data.metadata;
  const {
    clerk_user_id,
    pack_id,
    payment_id
  } = metadata;

  const pack = getPackById(pack_id);
  if (!pack) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/pricing?status=failed`
    );
  }

  // Grant credits
  await grantCredits(
    clerk_user_id,
    pack,
    payment_id,
    verifyData.data.reference
  );

  return Response.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}` +
    `/dashboard?payment=success&pack=${pack_id}`
  );
}
