-- Add byok_enabled column to provider_keys table
ALTER TABLE provider_keys 
ADD COLUMN IF NOT EXISTS byok_enabled BOOLEAN;

-- Add comment for documentation
COMMENT ON COLUMN provider_keys.byok_enabled IS 'Indicates whether this provider key is enabled for AI Gateway (BYOK - Bring Your Own Key)';

-- for local only:
CREATE OR REPLACE VIEW public.decrypted_provider_keys_v2 AS
SELECT
  pk.id,
  pk.org_id,
  pk.provider_name,
  pk.provider_key_name,
  pk.vault_key_id,
  pk.soft_delete,
  pk.created_at,
  pk.provider_key,
  pk.provider_key as decrypted_provider_key, -- this is only for local 
  pk.provider_secret_key,
  pk.provider_secret_key as decrypted_provider_secret_key, -- this is only for local
  pk.key_id,
  pk.auth_type,
  pk.nonce,
  pk.config,
  pk.byok_enabled
FROM public.provider_keys pk;



-- CREATE OR REPLACE VIEW public.decrypted_provider_keys_v2 AS
-- SELECT
--   pk.id,
--   pk.org_id,
--   pk.provider_name,
--   pk.provider_key_name,
--   pk.vault_key_id,
--   pk.soft_delete,
--   pk.created_at,
--   pk.provider_key,
--   pk.provider_secret_key,

--   -- decrypted_provider_key
--   CASE
--     WHEN pk.provider_key IS NULL OR pk.key_id IS NULL THEN NULL
--     ELSE convert_from(
--            pgsodium.crypto_aead_det_decrypt(
--              decode(translate(pk.provider_key, '-_', '+/'), 'base64'),
--              convert_to(pk.org_id::text, 'utf8'),
--              pk.key_id,
--              pk.nonce),
--            'utf8')
--   END AS decrypted_provider_key,

--   -- decrypted_provider_secret_key
--   CASE
--     WHEN pk.provider_secret_key IS NULL OR pk.key_id IS NULL THEN NULL
--     ELSE convert_from(
--            pgsodium.crypto_aead_det_decrypt(
--              decode(translate(pk.provider_secret_key, '-_', '+/'), 'base64'),
--              convert_to(pk.org_id::text, 'utf8'),
--              pk.key_id,
--              pk.nonce),
--            'utf8')
--   END AS decrypted_provider_secret_key,

--   pk.key_id,
--   pk.auth_type,
--   pk.nonce,
--   pk.config,
--   pk.byok_enabled
-- FROM public.provider_keys pk;

-- ------------------------------------------------------------------
-- -- 3. Permissions: only service_role can read the view
-- ------------------------------------------------------------------
REVOKE ALL ON public.decrypted_provider_keys_v2 FROM anon, authenticated;
GRANT  SELECT ON public.decrypted_provider_keys_v2 TO service_role;

