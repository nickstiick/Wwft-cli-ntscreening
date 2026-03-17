// Gedeelde Supabase client voor alle API endpoints
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

module.exports = supabase;
