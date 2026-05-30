-- Run this in your Supabase SQL Editor:
-- SQL Editor -> New query -> paste -> Run

CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  id INT PRIMARY KEY DEFAULT 1,
  rates JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);
