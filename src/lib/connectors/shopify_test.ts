import { createClient } from "@supabase/supabase-js";
import { fetchShopifyStoreData } from "./shopify";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.substring(0, index).trim();
    const val = trimmed.substring(index + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = val;
  }
}

loadEnv();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function runTest() {
  const { data: integrations, error } = await supabase
    .from("user_integrations")
    .select("*");
    
  if (error) {
    console.error("Supabase error:", error);
    return;
  }
  
  console.log(`Found ${integrations.length} integrations to test.`);
  
  for (const integration of integrations) {
    console.log("\n====================================");
    console.log("Testing store:", integration.shopify_store_url);
    console.log("User ID:", integration.clerk_user_id);
    
    try {
      const data = await fetchShopifyStoreData(
        integration.shopify_store_url,
        integration.shopify_access_token
      );
      console.log(`Success! Fetched products count: ${data.products.length}`);
      if (data.products.length > 0) {
        console.log("First product gateway classification:", data.products[0]?.gateway_classification);
      }
    } catch (err: any) {
      console.error(`ERROR for store ${integration.shopify_store_url}:`, err.message);
      if (err.stack) {
        console.error(err.stack);
      }
    }
  }
}

runTest();
