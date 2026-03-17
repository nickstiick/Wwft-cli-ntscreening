-- ═══════════════════════════════════════════════════════════
-- Migratie v3: Privacy by design — anonieme herchecks
-- Vervangt screenings + kvk_monitoring tabellen
-- ═══════════════════════════════════════════════════════════

-- Oude tabellen verwijderen (bevatten persoonsgegevens)
DROP TABLE IF EXISTS kvk_monitoring CASCADE;
DROP TABLE IF EXISTS screenings CASCADE;

-- ─── HERCHECKS (alleen anoniem referentienummer, geen persoonsgegevens) ──
CREATE TABLE herchecks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referentie TEXT UNIQUE NOT NULL,            -- bijv. SCR-A3K9-X7M2
  tenant_id UUID REFERENCES tenants(id),
  activatiecode TEXT,
  -- Geen naam, geen geboortedatum, geen resultaten
  risico_niveau TEXT,                          -- laag/verhoogd/hoog (voor interval-bepaling)
  hercheck_datum DATE NOT NULL,
  hercheck_interval_maanden INTEGER NOT NULL DEFAULT 12,
  hercheck_email TEXT,
  actief BOOLEAN NOT NULL DEFAULT true,
  aangemaakt_op TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_herchecks_referentie ON herchecks(referentie);
CREATE INDEX idx_herchecks_datum ON herchecks(hercheck_datum) WHERE actief = true;
CREATE INDEX idx_herchecks_tenant ON herchecks(tenant_id);

ALTER TABLE herchecks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON herchecks
  FOR ALL USING (true) WITH CHECK (true);
