const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const sql = `
    CREATE TABLE IF NOT EXISTS email_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      template TEXT NOT NULL,
      sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;
  const { data, error } = await supabase.rpc('exec_sql', { sql });
  console.log(error || 'Table created successfully');
}
run();
