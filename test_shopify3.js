const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function test() {
  const { data } = await supabase.from('user_integrations').select('shopify_store_url, shopify_access_token').limit(1);
  const shop = data[0].shopify_store_url;
  const token = data[0].shopify_access_token;
  
  const shopRes = await fetch(`https://${shop}/admin/api/2024-04/shop.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  console.log("2024-04 Shop status:", shopRes.status);
  
  const shopRes2 = await fetch(`https://${shop}/admin/api/2024-07/shop.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  console.log("2024-07 Shop status:", shopRes2.status);
}
test();
