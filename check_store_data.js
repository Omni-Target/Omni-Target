const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function check() {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('clerk_user_id, store_snapshot');
    
  if (error) {
    console.error("Error:", error);
    return;
  }
  
  if (data) {
    for (const row of data) {
      if (row.store_snapshot) {
        const products = row.store_snapshot.products || [];
        console.log(`User ${row.clerk_user_id}: ${products.length} products`);
        const kissAndTell = products.filter(p => p.name.toLowerCase().includes('kiss') || p.name.toLowerCase().includes('tell'));
        if (kissAndTell.length > 0) {
          console.log("Found products:", JSON.stringify(kissAndTell, null, 2));
        }
      } else {
        console.log(`User ${row.clerk_user_id}: no store_snapshot`);
      }
    }
  }
}
check();
