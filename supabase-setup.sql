-- Supabase SQL: maak de activatiecodes tabel aan
-- Run dit in Supabase Dashboard > SQL Editor > New Query

CREATE TABLE activatiecodes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  email TEXT,
  credits_totaal INTEGER NOT NULL,
  credits_gebruikt INTEGER NOT NULL DEFAULT 0,
  bundel TEXT NOT NULL,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geldig_tot TIMESTAMPTZ NOT NULL,
  mollie_payment_id TEXT,
  notitie TEXT,
  bron TEXT DEFAULT 'mollie'
);

-- Index voor snelle code-lookups
CREATE INDEX idx_activatiecodes_code ON activatiecodes(code);

-- Row Level Security uitschakelen (we gebruiken service_role key)
ALTER TABLE activatiecodes ENABLE ROW LEVEL SECURITY;

-- Policy: alleen service_role heeft toegang
CREATE POLICY "Service role full access" ON activatiecodes
  FOR ALL
  USING (true)
  WITH CHECK (true);
