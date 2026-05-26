const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://bafwrcyruaxzojwofxym.supabase.co',
  'sb_secret_HWGdBH8_pYaQjVuHSrcENg_LpeXpatT'
);

async function test() {
  const { data, error } = await supabase
    .from('user_integrations')
    .select('*')
    .limit(1);
    
  if (error) {
    console.error("Supabase error:", error);
    return;
  }
  
  if (data && data.length > 0) {
    console.log("Columns:", Object.keys(data[0]));
  }
}

test();
