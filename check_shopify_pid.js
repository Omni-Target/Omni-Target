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
    
  if (data) {
    const shopDomain = data.shopify_store_url;
    const accessToken = data.shopify_access_token;
    
    let url = `https://${shopDomain}/admin/api/2026-01/orders.json?status=any&limit=250&fields=id,created_at,line_items`;
    
    let kissOrders = 0;
    try {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
      const body = await res.json();
      const orders = body.orders || [];
      
      orders.forEach(order => {
        let found = false;
        order.line_items.forEach(item => {
          if (String(item.product_id) === '9288774287597') {
            found = true;
          }
        });
        if (found) kissOrders++;
      });
      
      console.log(`Kiss & Tell found in ${kissOrders} orders by product_id.`);
      
      if (kissOrders === 0) {
        console.log("Let's fetch all products to see if it was sold as a custom item or different ID:");
        let foundAny = 0;
        orders.forEach(o => {
          o.line_items.forEach(i => {
             if (i.title && i.title.toLowerCase().includes('kiss')) {
                console.log("Found line item with kiss:", i.title, "ID:", i.product_id);
             }
          });
        });
      }
    } catch (e) { console.error(e); }
  }
}
check();
