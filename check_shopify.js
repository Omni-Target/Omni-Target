const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function check() {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('clerk_user_id, shopify_store_url, shopify_access_token')
    .eq('clerk_user_id', 'user_3Dgiox6gi2NWgkIZLlzZfwLXGry')
    .single();
    
  if (error) {
    console.error("Error:", error);
    return;
  }
  
  if (data) {
    const shopDomain = data.shopify_store_url;
    const accessToken = data.shopify_access_token;
    
    // Fetch orders directly from Shopify to inspect line items
    let url = `https://${shopDomain}/admin/api/2026-01/orders.json?status=any&limit=250&fields=id,created_at,line_items`;
    
    let totalOrders = 0;
    let kissOrders = 0;
    
    try {
      const res = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json();
      const orders = body.orders || [];
      totalOrders += orders.length;
      
      orders.forEach(order => {
        let found = false;
        order.line_items.forEach(item => {
          if (item.title && item.title.toLowerCase().includes('kiss & tell')) {
            found = true;
          }
          if (item.name && item.name.toLowerCase().includes('kiss & tell')) {
            found = true;
          }
        });
        if (found) {
          kissOrders++;
          console.log(`Found order ${order.id} with Kiss & Tell. Created: ${order.created_at}`);
        }
      });
      
      console.log(`Checked ${totalOrders} orders. Kiss & Tell found in ${kissOrders} orders.`);
      
    } catch (e) {
      console.error(e);
    }
  }
}
check();
