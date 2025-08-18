/*
  # Fix Billing Periods Accurately (Final Cleaned Migration)

  - Proper dependency drop order
  - Enum-safe functions
  - Accurate subscription period calculation
  - Automatic billing text updates
  - Data correction and validation
*/

-- Drop dependent trigger first (to avoid function dependency errors)
DROP TRIGGER IF EXISTS trigger_update_billing_period_text ON subscriptions;

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS calculate_subscription_period_end(text, timestamptz);
DROP FUNCTION IF EXISTS calculate_subscription_period_end(subscription_plan_type, timestamptz);
DROP FUNCTION IF EXISTS update_billing_period_text();
DROP FUNCTION IF EXISTS validate_billing_period_accuracy();
DROP FUNCTION IF EXISTS generate_billing_period_text(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS generate_billing_period_text(timestamptz, timestamptz, subscription_plan_type);
DROP FUNCTION IF EXISTS handle_subscription_webhook(uuid, text, text, text, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS fix_existing_billing_periods();

-- Enhanced function to calculate accurate subscription period end
CREATE OR REPLACE FUNCTION calculate_subscription_period_end(
  plan_type subscription_plan_type,
  period_start timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  period_end timestamptz;
BEGIN
  CASE plan_type
    WHEN 'trial' THEN
      period_end := period_start + INTERVAL '30 days';
    WHEN 'monthly' THEN
      period_end := period_start + INTERVAL '1 month';
    WHEN 'semiannual' THEN
      period_end := period_start + INTERVAL '6 months';
    WHEN 'annual' THEN
      period_end := period_start + INTERVAL '1 year';
    ELSE
      period_end := period_start + INTERVAL '30 days';
  END CASE;
  
  RETURN period_end;
END;
$$;

-- Function to generate professional billing period text (enum-safe)
CREATE OR REPLACE FUNCTION generate_billing_period_text(
  period_start timestamptz,
  period_end timestamptz,
  plan_type subscription_plan_type
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  start_formatted text;
  end_formatted text;
  duration_text text;
  actual_days integer;
  is_expired boolean;
  status_prefix text;
BEGIN
  actual_days := EXTRACT(DAY FROM (period_end - period_start));
  is_expired := period_end <= now();
  
  start_formatted := to_char(period_start, 'Mon DD, YYYY');
  end_formatted := to_char(period_end, 'Mon DD, YYYY');
  
  CASE plan_type
    WHEN 'trial' THEN
      duration_text := actual_days || ' day trial';
    WHEN 'monthly' THEN
      duration_text := '1 month';
    WHEN 'semiannual' THEN
      duration_text := '6 months';
    WHEN 'annual' THEN
      duration_text := '1 year';
    ELSE
      duration_text := actual_days || ' days';
  END CASE;
  
  IF is_expired THEN
    status_prefix := 'Expired: ';
  ELSE
    status_prefix := '';
  END IF;
  
  RETURN status_prefix || start_formatted || ' – ' || end_formatted || ' (' || duration_text || ')';
END;
$$;

-- Function to validate billing period accuracy
CREATE OR REPLACE FUNCTION validate_billing_period_accuracy(
  period_start timestamptz,
  period_end timestamptz,
  plan_type subscription_plan_type
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  expected_end timestamptz;
  actual_days integer;
  expected_days integer;
  tolerance_days integer := 2;
BEGIN
  expected_end := calculate_subscription_period_end(plan_type, period_start);
  
  actual_days := EXTRACT(DAY FROM (period_end - period_start));
  expected_days := EXTRACT(DAY FROM (expected_end - period_start));
  
  RETURN ABS(actual_days - expected_days) <= tolerance_days;
END;
$$;

-- Function to update billing period text (trigger)
CREATE OR REPLACE FUNCTION update_billing_period_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.billing_period_text := generate_billing_period_text(
    NEW.current_period_start,
    NEW.current_period_end,
    NEW.plan_type
  );
  
  NEW.billing_period_accurate := validate_billing_period_accuracy(
    NEW.current_period_start,
    NEW.current_period_end,
    NEW.plan_type
  );
  
  RETURN NEW;
END;
$$;

-- Enhanced subscription webhook handler
CREATE OR REPLACE FUNCTION handle_subscription_webhook(
  p_user_id uuid,
  p_plan_type subscription_plan_type,
  p_status text,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  subscription_record subscriptions%ROWTYPE;
  calculated_period_start timestamptz;
  calculated_period_end timestamptz;
  result json;
BEGIN
  calculated_period_start := COALESCE(p_period_start, now());
  
  IF p_period_end IS NULL THEN
    calculated_period_end := calculate_subscription_period_end(p_plan_type, calculated_period_start);
  ELSE
    calculated_period_end := p_period_end;
  END IF;

  SELECT * INTO subscription_record
  FROM subscriptions
  WHERE user_id = p_user_id;

  IF FOUND THEN
    UPDATE subscriptions
    SET 
      plan_type = p_plan_type,
      status = p_status::subscription_status,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      current_period_start = calculated_period_start,
      current_period_end = calculated_period_end,
      updated_at = now()
    WHERE user_id = p_user_id
    RETURNING * INTO subscription_record;
  ELSE
    INSERT INTO subscriptions (
      user_id,
      plan_type,
      status,
      stripe_subscription_id,
      stripe_customer_id,
      current_period_start,
      current_period_end
    ) VALUES (
      p_user_id,
      p_plan_type,
      p_status::subscription_status,
      p_stripe_subscription_id,
      p_stripe_customer_id,
      calculated_period_start,
      calculated_period_end
    )
    RETURNING * INTO subscription_record;
  END IF;

  result := json_build_object(
    'success', true,
    'subscription_id', subscription_record.id,
    'plan_type', subscription_record.plan_type,
    'status', subscription_record.status,
    'period_start', subscription_record.current_period_start,
    'period_end', subscription_record.current_period_end,
    'billing_period_text', subscription_record.billing_period_text,
    'billing_period_accurate', subscription_record.billing_period_accurate
  );

  RETURN result;
END;
$$;

-- Function to fix existing billing periods
CREATE OR REPLACE FUNCTION fix_existing_billing_periods()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  sub_record subscriptions%ROWTYPE;
  corrected_end timestamptz;
BEGIN
  FOR sub_record IN 
    SELECT * FROM subscriptions 
    WHERE billing_period_accurate = false OR billing_period_accurate IS NULL
  LOOP
    corrected_end := calculate_subscription_period_end(
      sub_record.plan_type, 
      sub_record.current_period_start
    );
    
    UPDATE subscriptions
    SET 
      current_period_end = corrected_end,
      updated_at = now()
    WHERE id = sub_record.id;
    
    RAISE NOTICE 'Fixed billing period for subscription %: % to %', 
      sub_record.id, sub_record.current_period_end, corrected_end;
  END LOOP;
END;
$$;

-- Recreate the trigger
CREATE TRIGGER trigger_update_billing_period_text
  BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_billing_period_text();

-- Fix existing billing periods immediately
SELECT fix_existing_billing_periods();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_period_accurate 
ON subscriptions (billing_period_accurate) 
WHERE billing_period_accurate = false;

CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end 
ON subscriptions (current_period_end);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_type 
ON subscriptions (plan_type);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status 
ON subscriptions (status);
