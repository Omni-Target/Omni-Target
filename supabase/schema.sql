-- Run this in Supabase SQL Editor:
-- supabase.com → your project → 
-- SQL Editor → New query → paste → Run

-- =====================
-- OMNI-TARGET SCHEMA
-- =====================

-- Stores connected Shopify and Meta 
-- accounts per Clerk user

CREATE TABLE IF NOT EXISTS user_integrations (
  id UUID DEFAULT gen_random_uuid() 
    PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  
  -- Shopify
  shopify_store_url TEXT,
  shopify_access_token TEXT,
  shopify_webhook_id TEXT,
  shopify_refresh_token TEXT,
  shopify_token_expires_at TIMESTAMPTZ,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  
  -- Meta
  meta_access_token TEXT,
  meta_ad_account_id TEXT,
  meta_pixel_id TEXT,
  meta_business_id TEXT,
  meta_connected_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stores every campaign created 
-- by each user

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID DEFAULT gen_random_uuid() 
    PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  
  -- Campaign inputs
  brand_name TEXT,
  product_name TEXT,
  product_description TEXT,
  target_audience TEXT,
  campaign_goal TEXT,
  tone_preference TEXT,
  platform TEXT,
  media_url TEXT,
  
  -- Generated copy
  headline TEXT,
  primary_text TEXT,
  description TEXT,
  cta TEXT,
  copywriter_note TEXT,
  
  -- Meta campaign IDs (after launch)
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  
  -- Status
  status TEXT DEFAULT 'draft',
  -- draft | launched | paused | error
  
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stores CAPI events sent to Meta
-- for audit trail and deduplication

CREATE TABLE IF NOT EXISTS capi_events (
  id UUID DEFAULT gen_random_uuid() 
    PRIMARY KEY,
  clerk_user_id TEXT,
  shopify_order_id TEXT NOT NULL,
  order_value DECIMAL(10,2),
  currency TEXT DEFAULT 'NGN',
  event_sent_at TIMESTAMPTZ DEFAULT NOW(),
  meta_response JSONB,
  status TEXT DEFAULT 'sent'
  -- sent | failed | deduplicated
);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION 
  update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_integrations_updated_at
  BEFORE UPDATE ON user_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Add pixel health and metadata to user_integrations
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS pixel_health TEXT DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS pixel_installed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS meta_page_id TEXT,
ADD COLUMN IF NOT EXISTS meta_page_name TEXT,
ADD COLUMN IF NOT EXISTS meta_ad_accounts JSONB,
ADD COLUMN IF NOT EXISTS meta_selected_account_id TEXT,
ADD COLUMN IF NOT EXISTS meta_pages JSONB,
ADD COLUMN IF NOT EXISTS meta_page_access_token TEXT,
ADD COLUMN IF NOT EXISTS shopify_custom_domain TEXT;

-- Cache for exchange rates
CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  id INT PRIMARY KEY DEFAULT 1,
  rates JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- Stores token usage for Anthropic API calls
CREATE TABLE IF NOT EXISTS api_usage_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT,
  feature TEXT,
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
