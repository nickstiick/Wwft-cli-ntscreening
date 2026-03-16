-- ═══════════════════════════════════════════════════════════
-- Migratie v2: Multi-tenant, Screening History, REST API, Hercheck
-- Run dit in Supabase Dashboard > SQL Editor > New Query
-- ═══════════════════════════════════════════════════════════

-- ─── TENANTS (multi-tenant / white-label) ─────────────────
CREATE TABLE tenants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  kantoor_naam TEXT,
  logo_url TEXT,
  kleur TEXT DEFAULT '#1a1a2e',
  adres TEXT,
  telefoon TEXT,
  website TEXT,
  disclaimer TEXT,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_email ON tenants(email);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON tenants
  FOR ALL USING (true) WITH CHECK (true);

-- ─── Koppel activatiecodes aan tenants ────────────────────
ALTER TABLE activatiecodes ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
CREATE INDEX idx_activatiecodes_tenant ON activatiecodes(tenant_id);

-- ─── API KEYS (REST API toegang) ─────────────────────────
CREATE TABLE api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  api_key TEXT UNIQUE NOT NULL,
  naam TEXT,
  credits_totaal INTEGER NOT NULL DEFAULT 0,
  credits_gebruikt INTEGER NOT NULL DEFAULT 0,
  actief BOOLEAN NOT NULL DEFAULT true,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geldig_tot TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_api_keys_key ON api_keys(api_key);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON api_keys
  FOR ALL USING (true) WITH CHECK (true);

-- ─── SCREENINGS (historie + hercheck) ────────────────────
CREATE TABLE screenings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  activatiecode TEXT,
  api_key_id UUID REFERENCES api_keys(id),
  -- Subject gegevens
  naam TEXT NOT NULL,
  geboortedatum TEXT,
  type TEXT DEFAULT 'natuurlijk_persoon',
  locatie TEXT,
  land TEXT DEFAULT 'Nederland',
  kvk_nummer TEXT,
  -- Resultaten
  risico_niveau TEXT,
  risico_score INTEGER,
  samenvatting TEXT,
  resultaten JSONB,
  analyse JSONB,
  -- Hercheck
  hercheck_datum DATE,
  hercheck_interval_maanden INTEGER DEFAULT 12,
  hercheck_actief BOOLEAN DEFAULT false,
  hercheck_email TEXT,
  -- Meta
  bron TEXT DEFAULT 'web',
  medewerker TEXT,
  dossiernummer TEXT,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_screenings_tenant ON screenings(tenant_id);
CREATE INDEX idx_screenings_naam ON screenings(naam);
CREATE INDEX idx_screenings_kvk ON screenings(kvk_nummer) WHERE kvk_nummer IS NOT NULL;
CREATE INDEX idx_screenings_hercheck ON screenings(hercheck_datum) WHERE hercheck_actief = true;
CREATE INDEX idx_screenings_aangemaakt ON screenings(aangemaakt_op DESC);

ALTER TABLE screenings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON screenings
  FOR ALL USING (true) WITH CHECK (true);

-- ─── KVK MONITORING (voorbereiding KVK Mutatieservice) ──
-- Houdt bij welke KVK-nummers gemonitord worden voor wijzigingen.
-- Bij een mutatie wordt automatisch een hercheck getriggerd.
CREATE TABLE kvk_monitoring (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  kvk_nummer TEXT NOT NULL,
  bedrijfsnaam TEXT,
  -- Welke mutatie-types monitoren
  monitor_bestuurswisseling BOOLEAN DEFAULT true,
  monitor_adreswijziging BOOLEAN DEFAULT true,
  monitor_sbi_wijziging BOOLEAN DEFAULT true,
  monitor_faillissement BOOLEAN DEFAULT true,
  -- Laatste bekende staat (voor vergelijking)
  laatste_check TIMESTAMPTZ,
  laatste_mutatie JSONB,
  -- Koppeling naar meest recente screening
  laatste_screening_id UUID REFERENCES screenings(id),
  -- Meta
  actief BOOLEAN DEFAULT true,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_kvk_monitoring_unique ON kvk_monitoring(tenant_id, kvk_nummer) WHERE actief = true;
CREATE INDEX idx_kvk_monitoring_kvk ON kvk_monitoring(kvk_nummer) WHERE actief = true;

ALTER TABLE kvk_monitoring ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON kvk_monitoring
  FOR ALL USING (true) WITH CHECK (true);
