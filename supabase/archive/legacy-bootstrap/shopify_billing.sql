-- Shopify Billing Schema Migration
-- Run this in your Supabase SQL Editor:
-- supabase.com -> your project -> SQL Editor -> New query -> paste -> Run

-- Add shop_domain column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS shop_domain TEXT;

-- Add access_token column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS access_token TEXT;

-- Add credits column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;

-- Add free_credit_used column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS free_credit_used BOOLEAN DEFAULT FALSE;

-- Index for fast lookups by shop_domain / shopify_store_url
CREATE INDEX IF NOT EXISTS idx_user_integrations_shop_domain ON user_integrations(shop_domain);
CREATE INDEX IF NOT EXISTS idx_user_integrations_shopify_store_url ON user_integrations(shopify_store_url);
