const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function check() {
  const { data } = await supabase.from('user_integrations').select('clerk_user_id, shopify_store_url, shop_domain');
  console.log(data);
}
check();
