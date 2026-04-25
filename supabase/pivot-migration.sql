-- Omni-target Pivot: Store Intelligence Schema Updates
-- Run this in your Supabase SQL Editor

-- Add store snapshot caching to user_integrations
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS store_snapshot JSONB,
ADD COLUMN IF NOT EXISTS store_snapshot_at TIMESTAMPTZ;

-- Add brief/targeting/insights columns to campaigns table
ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS brief_data JSONB,
ADD COLUMN IF NOT EXISTS targeting_data JSONB,
ADD COLUMN IF NOT EXISTS store_insights JSONB;

-- Note: We are NOT removing Meta launch columns yet
-- (meta_campaign_id, launched_at, etc.) in case we need them later.
