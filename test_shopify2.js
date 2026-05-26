const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function test() {
  const { data } = await supabase.from('user_integrations').select('shopify_store_url, shopify_access_token').limit(1);
  const shop = data[0].shopify_store_url;
  const token = data[0].shopify_access_token;
  
  const shopRes = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  console.log("2024-01 Shop status:", shopRes.status);
  const d = await shopRes.json();
  console.log(d);
}
test();
