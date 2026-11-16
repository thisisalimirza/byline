-- Saved work and credits stay ready for accounts.
-- Apply every file in supabase/migrations, in filename order, before setting
-- SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.
-- Row level security is on for every table. Do not use supabase db push or db reset.

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_history ENABLE ROW LEVEL SECURITY;

-- The server writes drafts and products with the service role, scoped to the signed-in user.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'drafts' AND policyname = 'Service role can manage drafts'
  ) THEN
    CREATE POLICY "Service role can manage drafts" ON drafts
      FOR ALL
      USING (auth.jwt()->>'role' = 'service_role')
      WITH CHECK (auth.jwt()->>'role' = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'products' AND policyname = 'Service role can manage products'
  ) THEN
    CREATE POLICY "Service role can manage products" ON products
      FOR ALL
      USING (auth.jwt()->>'role' = 'service_role')
      WITH CHECK (auth.jwt()->>'role' = 'service_role');
  END IF;
END $$;
