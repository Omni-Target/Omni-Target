-- Shopify Token Exchange Schema Migration
-- Run this in your Supabase SQL Editor:
-- supabase.com -> your project -> SQL Editor -> New query -> paste -> Run

-- Add refresh_token column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS refresh_token TEXT;

-- Add token_expires_at column if it does not exist
ALTER TABLE user_integrations
ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

-- Index for fast token expiry lookups
CREATE INDEX IF NOT EXISTS idx_user_integrations_token_expires_at ON user_integrations(token_expires_at);
