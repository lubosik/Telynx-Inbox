-- LUKO / Vici cart-connector pgcrypto lookup correction.
-- Additive and rerunnable. No cart rows, contacts, consent, or messages change.
-- Run after cart-recovery-growth-migration.sql and cart-recovery-voice-migration.sql.
--
-- These SECURITY DEFINER functions intentionally run with search_path=''.
-- pgcrypto's digest() is not a pg_catalog function, so its schema must be
-- named explicitly inside the function bodies. Error 42883 was observed on
-- connector events when the unqualified digest() call was reached.

BEGIN;

DO $$
DECLARE
  v_pgcrypto_schema text;
  v_function regprocedure;
  v_definition text;
  v_corrected text;
  v_corrected_count integer := 0;
BEGIN
  SELECT n.nspname INTO v_pgcrypto_schema
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';
  IF v_pgcrypto_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is not installed; apply the cart recovery migrations first';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.resolve_luko_cart_customer_identity(text,text,text,text)'::regprocedure,
    'public.apply_luko_cart_event(jsonb,text)'::regprocedure
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    -- Qualify only bare digest( calls. An already-qualified call is unchanged,
    -- so rerunning this migration cannot add a second schema prefix.
    v_corrected := pg_catalog.regexp_replace(
      v_definition,
      E'(^|[^[:alnum:]_.])digest[[:space:]]*\\(',
      E'\\1' || pg_catalog.quote_ident(v_pgcrypto_schema) || '.digest(',
      'g'
    );
    IF v_corrected <> v_definition THEN
      EXECUTE v_corrected;
      v_corrected_count := v_corrected_count + 1;
    END IF;
    IF pg_catalog.pg_get_functiondef(v_function) ~ E'(^|[^[:alnum:]_.])digest[[:space:]]*\\(' THEN
      RAISE EXCEPTION 'Unqualified digest() remains in %', v_function;
    END IF;
  END LOOP;

  RAISE NOTICE 'Corrected % cart connector function(s); pgcrypto schema is %',
    v_corrected_count, v_pgcrypto_schema;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
