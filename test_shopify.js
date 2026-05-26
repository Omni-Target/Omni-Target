const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function test() {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('shopify_store_url, shopify_access_token, clerk_user_id')
    .limit(1);
    
  if (error || !data || data.length === 0) {
    console.error("Supabase error:", error);
    return;
  }
  
  const shop = data[0].shopify_store_url;
  const token = data[0].shopify_access_token;
  console.log("Testing shop:", shop);
  
  // Test shop.json
  const shopRes = await fetch(`https://${shop}/admin/api/2026-01/shop.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  console.log("Shop status:", shopRes.status);
  
  // Test products.json
  const prodRes = await fetch(`https://${shop}/admin/api/2026-01/products.json?limit=250&status=active`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  console.log("Products status:", prodRes.status);
  const prodData = await prodRes.json();
  console.log("Products count:", prodData.products ? prodData.products.length : prodData);
}

test();
