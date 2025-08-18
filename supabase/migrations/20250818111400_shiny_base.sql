/*
  # Fix Billing Periods Accurately

  1. Database Functions
    - Enhanced billing period calculation with proper date math
    - Professional billing period text generation
    - Accurate period validation and correction

  2. Triggers
    - Auto-update billing period text on subscription changes
    - Validate billing period accuracy

  3. Data Correction
    - Fix existing incorrect billing periods
    - Ensure all future periods are calculated correctly
*/

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS calculate_subscription_period_end(text, timestamptz);
DROP FUNCTION IF EXISTS update_billing_period_text();
DROP FUNCTION IF EXISTS update_billing_period_text_trigger();
DROP FUNCTION IF EXISTS validate_billing_period_accuracy();

-- Enhanced function to calculate accurate subscription period end
CREATE OR REPLACE FUNCTION calculate_subscription_period_end(
  plan_type text,
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
      -- Trial: exactly 30 days
      period_end := period_start + INTERVAL '30 days';
    WHEN 'monthly' THEN
      -- Monthly: add 1 month (handles month-end dates properly)
      period_end := period_start + INTERVAL '1 month';
    WHEN 'semiannual' THEN
      -- Semiannual: exactly 6 months
      period_end := period_start + INTERVAL '6 months';
    WHEN 'annual' THEN
      -- Annual: exactly 1 year
      period_end := period_start + INTERVAL '1 year';
    ELSE
      -- Default to 30 days for unknown plan types
      period_end := period_start + INTERVAL '30 days';
  END CASE;
  
  RETURN period_end;
END;
$$;

-- Function to generate professional billing period text
CREATE OR REPLACE FUNCTION generate_billing_period_text(
  period_start timestamptz,
  period_end timestamptz,
  plan_type text
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
  -- Calculate actual days between dates
  actual_days := EXTRACT(DAY FROM (period_end - period_start));
  
  -- Check if subscription is expired
  is_expired := period_end <= now();
  
  -- Format dates professionally
  start_formatted := to_char(period_start, 'Mon DD, YYYY');
  end_formatted := to_char(period_end, 'Mon DD, YYYY');
  
  -- Generate accurate duration text based on plan type and actual period
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
  
  -- Add status prefix for expired subscriptions
  IF is_expired THEN
    status_prefix := 'Expired: ';
  ELSE
    status_prefix := '';
  END IF;
  
  -- Return formatted billing period text
  RETURN status_prefix || start_formatted || ' – ' || end_formatted || ' (' || duration_text || ')';
END;
$$;

-- Function to update billing period text
CREATE OR REPLACE FUNCTION update_billing_period_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Generate accurate billing period text
  NEW.billing_period_text := generate_billing_period_text(
    NEW.current_period_start,
    NEW.current_period_end,
    NEW.plan_type
  );
  
  -- Validate billing period accuracy
  NEW.billing_period_accurate := validate_billing_period_accuracy(
    NEW.current_period_start,
    NEW.current_period_end,
    NEW.plan_type
  );
  
  RETURN NEW;
END;
$$;

-- Function to validate billing period accuracy
CREATE OR REPLACE FUNCTION validate_billing_period_accuracy(
  period_start timestamptz,
  period_end timestamptz,
  plan_type text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  expected_end timestamptz;
  actual_days integer;
  expected_days integer;
  tolerance_days integer := 2; -- Allow 2 days tolerance
BEGIN
  -- Calculate expected end date
  expected_end := calculate_subscription_period_end(plan_type, period_start);
  
  -- Calculate actual vs expected days
  actual_days := EXTRACT(DAY FROM (period_end - period_start));
  expected_days := EXTRACT(DAY FROM (expected_end - period_start));
  
  -- Check if within tolerance
  RETURN ABS(actual_days - expected_days) <= tolerance_days;
END;
$$;

-- Enhanced subscription webhook handler
CREATE OR REPLACE FUNCTION handle_subscription_webhook(
  p_user_id uuid,
  p_plan_type text,
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
  -- Use provided dates or calculate accurate ones
  calculated_period_start := COALESCE(p_period_start, now());
  
  IF p_period_end IS NULL THEN
    calculated_period_end := calculate_subscription_period_end(p_plan_type, calculated_period_start);
  ELSE
    calculated_period_end := p_period_end;
  END IF;

  -- Check if subscription exists
  SELECT * INTO subscription_record
  FROM subscriptions
  WHERE user_id = p_user_id;

  IF FOUND THEN
    -- Update existing subscription
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
    -- Create new subscription
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
      p_plan_type::subscription_plan_type,
      p_status::subscription_status,
      p_stripe_subscription_id,
      p_stripe_customer_id,
      calculated_period_start,
      calculated_period_end
    )
    RETURNING * INTO subscription_record;
  END IF;

  -- Return success result
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
  -- Loop through all subscriptions and fix their billing periods
  FOR sub_record IN 
    SELECT * FROM subscriptions 
    WHERE billing_period_accurate = false OR billing_period_accurate IS NULL
  LOOP
    -- Calculate correct period end
    corrected_end := calculate_subscription_period_end(
      sub_record.plan_type::text, 
      sub_record.current_period_start
    );
    
    -- Update with corrected dates
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
DROP TRIGGER IF EXISTS trigger_update_billing_period_text ON subscriptions;
CREATE TRIGGER trigger_update_billing_period_text
  BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_billing_period_text();

-- Fix existing billing periods
SELECT fix_existing_billing_periods();

-- Add helpful indexes for billing period queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_period_accurate 
ON subscriptions (billing_period_accurate) 
WHERE billing_period_accurate = false;

CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end 
ON subscriptions (current_period_end);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_type 
ON subscriptions (plan_type);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status 
ON subscriptions (status);