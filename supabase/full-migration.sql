-- =============================================
-- OMNI-TARGET: FULL DATABASE MIGRATION
-- =============================================
-- Run this in Supabase SQL Editor:
-- supabase.com → your project →
-- SQL Editor → New query → paste → Run
--
-- This is a consolidated migration that creates
-- ALL tables with ALL columns for a fresh project.
-- =============================================

-- =====================
-- 1. USER INTEGRATIONS
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
  shopify_custom_domain TEXT,
  shop_domain TEXT,
  access_token TEXT,
  shopify_refresh_token TEXT,
  shopify_token_expires_at TIMESTAMPTZ,

  -- Meta
  meta_access_token TEXT,
  meta_ad_account_id TEXT,
  meta_pixel_id TEXT,
  meta_business_id TEXT,
  meta_connected_at TIMESTAMPTZ,
  meta_page_id TEXT,
  meta_page_name TEXT,
  meta_ad_accounts JSONB,
  meta_selected_account_id TEXT,
  meta_pages JSONB,
  meta_page_access_token TEXT,

  -- Pixel health
  pixel_health TEXT DEFAULT 'unknown',
  pixel_installed_at TIMESTAMPTZ,

  -- Store intelligence
  store_snapshot JSONB,
  store_snapshot_at TIMESTAMPTZ,

  -- Credits system
  credits INTEGER DEFAULT 0,
  credits_balance INTEGER DEFAULT 0,
  credits_total_purchased INTEGER DEFAULT 0,
  credits_unlimited_until TIMESTAMPTZ,
  free_credit_used BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_integrations_shop_domain
  ON user_integrations(shop_domain);
CREATE INDEX IF NOT EXISTS idx_user_integrations_shopify_store_url
  ON user_integrations(shopify_store_url);

-- =====================
-- 2. CAMPAIGNS
-- =====================
-- Stores every campaign created by each user

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
  -- draft | launched | paused | active | stopped | error

  -- Store intelligence data
  brief_data JSONB,
  targeting_data JSONB,
  store_insights JSONB,

  -- Timestamps
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================
-- 3. CAPI EVENTS
-- =====================
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

-- =====================
-- 4. PAYMENTS
-- =====================
-- Stores payment records for credit purchases

CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT gen_random_uuid()
    PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- paystack | stripe
  pack TEXT NOT NULL,
  amount_ngn DECIMAL(10,2),
  amount_usd DECIMAL(10,2),
  currency TEXT NOT NULL DEFAULT 'NGN',
  credits_granted INTEGER DEFAULT 0,
  unlimited_days INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  -- pending | success | failed
  provider_reference TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================
-- 5. CREDIT USAGE
-- =====================
-- Tracks credit usage for audit trail

CREATE TABLE IF NOT EXISTS credit_usage (
  id UUID DEFAULT gen_random_uuid()
    PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  credits_used INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL,
  -- brief_generated | etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================
-- 6. TRIGGERS
-- =====================
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

CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
