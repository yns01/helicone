ALTER TABLE request_response_rmt
ADD COLUMN IF NOT EXISTS is_passthrough_billing Boolean DEFAULT false AFTER request_referrer;
