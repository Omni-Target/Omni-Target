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
  shopify_scopes TEXT,
  -- Legacy token-exchange columns (still read by app)
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,

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
CREATE INDEX IF NOT EXISTS idx_user_integrations_token_expires_at
  ON user_integrations(token_expires_at);

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
  product_price TEXT,
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
-- 6. EXCHANGE RATE CACHE
-- =====================
-- Single-row cache of currency exchange rates

CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  id INT PRIMARY KEY DEFAULT 1,
  rates JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- =====================
-- 7. API USAGE LOG
-- =====================
-- Tracks token usage for Anthropic API calls

CREATE TABLE IF NOT EXISTS api_usage_log (
  id UUID DEFAULT gen_random_uuid()
    PRIMARY KEY,
  user_id TEXT,
  feature TEXT,
  input_tokens INT,
  output_tokens INT,
  total_tokens INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================
-- 8. EMAIL LOG
-- =====================
-- Tracks transactional emails sent per user
-- to prevent duplicate sends

CREATE TABLE IF NOT EXISTS email_log (
  id UUID DEFAULT gen_random_uuid()
    PRIMARY KEY,
  user_id TEXT,
  template TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_log_user_template
  ON email_log(user_id, template);

-- =====================
-- 9. TRIGGERS
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

-- =====================
-- 10. PAYMENT INTEGRITY (0001)
-- =====================
-- Idempotency guard for payments
CREATE TABLE IF NOT EXISTS processed_payments (
  payment_id   TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomic credit increment
CREATE OR REPLACE FUNCTION increment_credits(
  p_user_id TEXT,
  p_credits INTEGER,
  p_total   INTEGER
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE user_integrations
  SET credits_balance         = COALESCE(credits_balance, 0) + p_credits,
      credits_total_purchased = COALESCE(credits_total_purchased, 0) + p_total
  WHERE clerk_user_id = p_user_id;
$$;

-- =====================
-- 11. RATE LIMITS (0002)
-- =====================
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key            TEXT,
  p_limit          INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_now   TIMESTAMPTZ := NOW();
  v_count INTEGER;
BEGIN
  INSERT INTO rate_limits AS rl (key, count, window_start)
  VALUES (p_key, 1, v_now)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN rl.window_start < v_now - MAKE_INTERVAL(secs => p_window_seconds)
            THEN 1
          ELSE rl.count + 1
        END,
        window_start = CASE
          WHEN rl.window_start < v_now - MAKE_INTERVAL(secs => p_window_seconds)
            THEN v_now
          ELSE rl.window_start
        END
  RETURNING rl.count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

-- =====================
-- 12. SHOPIFY REFRESH LOCKS (0003)
-- =====================
CREATE TABLE IF NOT EXISTS shopify_refresh_locks (
  user_id      TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION acquire_refresh_lock(
  p_user_id     TEXT,
  p_ttl_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_acquired BOOLEAN;
BEGIN
  INSERT INTO shopify_refresh_locks AS l (user_id, locked_until)
  VALUES (p_user_id, NOW() + MAKE_INTERVAL(secs => p_ttl_seconds))
  ON CONFLICT (user_id) DO UPDATE
    SET locked_until = EXCLUDED.locked_until
    WHERE l.locked_until < NOW()
  RETURNING true INTO v_acquired;

  RETURN COALESCE(v_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION release_refresh_lock(p_user_id TEXT)
RETURNS VOID
LANGUAGE sql
AS $$
  DELETE FROM shopify_refresh_locks WHERE user_id = p_user_id;
$$;

-- =====================
-- 13. CAMPAIGN BRIEF VERSIONS (0007, 0009)
-- =====================
CREATE TABLE IF NOT EXISTS campaign_brief_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  clerk_user_id   TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  headline        TEXT,
  primary_text    TEXT,
  description     TEXT,
  cta             TEXT,
  copywriter_note TEXT,
  is_selected     BOOLEAN NOT NULL DEFAULT false,
  brief_data      JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbv_campaign_id
  ON campaign_brief_versions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cbv_user_created
  ON campaign_brief_versions(clerk_user_id, created_at DESC);

-- =====================
-- 14. BRIEF GENERATION RECEIPTS & RPCS (0009)
-- =====================
CREATE TABLE IF NOT EXISTS brief_generation_receipts (
  clerk_user_id TEXT NOT NULL,
  request_id    UUID NOT NULL,
  request_hash  TEXT NOT NULL,
  response      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clerk_user_id, request_id)
);

CREATE OR REPLACE FUNCTION commit_brief_generation(
  p_user_id TEXT, p_request_id UUID, p_request_hash TEXT, p_campaign_id UUID,
  p_campaign JSONB, p_copy JSONB, p_context JSONB, p_response JSONB
) RETURNS JSONB LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  u user_integrations%ROWTYPE;
  c campaigns%ROWTYPE;
  prior brief_generation_receipts%ROWTYPE;
  campaign_id UUID;
  version_id UUID;
  attempt INTEGER;
  balance INTEGER;
  unlimited BOOLEAN;
  result JSONB;
BEGIN
  -- Serialize all commits for this user, including retries and concurrent tabs.
  SELECT * INTO u FROM user_integrations WHERE clerk_user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'integration_not_found'; END IF;
  SELECT * INTO prior FROM brief_generation_receipts WHERE clerk_user_id = p_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.request_hash <> p_request_hash THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN prior.response;
  END IF;
  balance := COALESCE((TO_JSONB(u)->>'credits')::INTEGER, u.credits_balance, 0);
  unlimited := COALESCE(u.credits_unlimited_until > NOW(), false);
  IF p_campaign_id IS NOT NULL THEN
    SELECT * INTO c FROM campaigns WHERE id = p_campaign_id AND clerk_user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_regeneration'; END IF;
    IF c.product_name IS DISTINCT FROM p_campaign->>'product_name'
       OR c.product_description IS DISTINCT FROM p_campaign->>'product_description'
       OR c.campaign_goal IS DISTINCT FROM p_campaign->>'campaign_goal'
       OR c.product_price IS DISTINCT FROM p_campaign->>'product_price' THEN
      RAISE EXCEPTION 'regeneration_product_changed';
    END IF;
    SELECT COUNT(*) + 1 INTO attempt FROM campaign_brief_versions WHERE campaign_id = c.id AND clerk_user_id = p_user_id;
    IF attempt < 2 OR attempt > 4 THEN RAISE EXCEPTION 'regeneration_limit'; END IF;
    campaign_id := c.id;
  ELSE
    IF NOT unlimited AND balance < 1 THEN RAISE EXCEPTION 'no_credits'; END IF;
    INSERT INTO campaigns (clerk_user_id, status, brand_name, product_name, product_description, target_audience,
      campaign_goal, tone_preference, platform, media_url, product_price, headline, primary_text, description, cta, copywriter_note, brief_data)
    VALUES (p_user_id, 'draft', p_campaign->>'brand_name', p_campaign->>'product_name', p_campaign->>'product_description',
      p_campaign->>'target_audience', p_campaign->>'campaign_goal', p_campaign->>'tone_preference', p_campaign->>'platform',
      p_campaign->>'media_url', p_campaign->>'product_price', p_copy->>'headline', p_copy->>'primary_text', p_copy->>'description',
      p_copy->>'cta', p_copy->>'copywriter_note', p_context) RETURNING id INTO campaign_id;
    attempt := 1;
    IF NOT unlimited THEN
      balance := balance - 1;
      UPDATE user_integrations SET credits_balance = balance WHERE clerk_user_id = p_user_id;
      IF TO_JSONB(u) ? 'credits' THEN
        EXECUTE 'UPDATE user_integrations SET credits = $1 WHERE clerk_user_id = $2' USING balance, p_user_id;
      END IF;
      INSERT INTO credit_usage (clerk_user_id, credits_used, action) VALUES (p_user_id, 1, 'brief_generated');
    END IF;
  END IF;
  INSERT INTO campaign_brief_versions (campaign_id, clerk_user_id, attempt_number, is_selected,
    headline, primary_text, description, cta, copywriter_note, brief_data)
  VALUES (campaign_id, p_user_id, attempt, attempt = 1, p_copy->>'headline', p_copy->>'primary_text',
    p_copy->>'description', p_copy->>'cta', p_copy->>'copywriter_note', p_context) RETURNING id INTO version_id;
  result := p_response || JSONB_BUILD_OBJECT('campaignId', campaign_id, 'versionId', version_id, 'attemptNumber', attempt,
    'credits_balance', balance, 'is_unlimited', unlimited);
  INSERT INTO brief_generation_receipts (clerk_user_id, request_id, request_hash, response)
    VALUES (p_user_id, p_request_id, p_request_hash, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION finalize_brief_version(
  p_user_id TEXT, p_campaign_id UUID, p_version_id UUID, p_context JSONB, p_copy JSONB, p_status TEXT
) RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v campaign_brief_versions%ROWTYPE;
  context JSONB;
BEGIN
  PERFORM 1 FROM campaigns WHERE id = p_campaign_id AND clerk_user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  SELECT * INTO v FROM campaign_brief_versions WHERE id = p_version_id AND campaign_id = p_campaign_id AND clerk_user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'version_not_found'; END IF;
  -- Keep immutable generation evidence; only user selections can be updated here.
  context := COALESCE(v.brief_data, '{}'::JSONB) || COALESCE(p_context, '{}'::JSONB);
  IF v.brief_data IS NOT NULL THEN
    context := context || (v.brief_data - 'selectedCta' - 'selectedDuration' - 'selectedStrategyIndex' - 'selectedIntlStrategyIndex');
  END IF;
  context := context || JSONB_BUILD_OBJECT('generatedCopy', JSONB_BUILD_OBJECT(
    'headline', v.headline, 'primaryText', v.primary_text, 'description', v.description, 'cta', v.cta, 'copywriterNote', v.copywriter_note));
  UPDATE campaign_brief_versions SET is_selected = (id = p_version_id) WHERE campaign_id = p_campaign_id AND clerk_user_id = p_user_id;
  UPDATE campaign_brief_versions SET brief_data = context WHERE id = p_version_id;
  UPDATE campaigns SET brief_data = context, headline = v.headline, primary_text = v.primary_text,
    description = v.description, cta = COALESCE(context->>'selectedCta', v.cta), copywriter_note = v.copywriter_note,
    status = CASE WHEN p_status = 'complete' THEN 'complete' ELSE status END, updated_at = NOW()
    WHERE id = p_campaign_id AND clerk_user_id = p_user_id;
END;
$$;

-- =====================
-- 15. ROW-LEVEL SECURITY & PERMISSIONS (0004, 0005, 0007, 0009)
-- =====================
ALTER TABLE processed_payments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits               ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_refresh_locks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_brief_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_generation_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION commit_brief_generation(TEXT, UUID, TEXT, UUID, JSONB, JSONB, JSONB, JSONB) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_brief_version(TEXT, UUID, UUID, JSONB, JSONB, TEXT)                FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION acquire_refresh_lock(TEXT, INTEGER)       FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION release_refresh_lock(TEXT)                FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION increment_credits(TEXT, INTEGER, INTEGER) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION check_rate_limit(TEXT, INTEGER, INTEGER)  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION commit_brief_generation(TEXT, UUID, TEXT, UUID, JSONB, JSONB, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_brief_version(TEXT, UUID, UUID, JSONB, JSONB, TEXT)                TO service_role;
GRANT EXECUTE ON FUNCTION acquire_refresh_lock(TEXT, INTEGER)       TO service_role;
GRANT EXECUTE ON FUNCTION release_refresh_lock(TEXT)                TO service_role;
GRANT EXECUTE ON FUNCTION increment_credits(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit(TEXT, INTEGER, INTEGER)  TO service_role;

