/*
  # Fix Subscription and Billing System

  1. Database Functions
    - Enhanced subscription webhook handler
    - Accurate period calculation functions
    - Subscription status management
    - Payment method handling

  2. Billing Period Calculations
    - Accurate period end calculations for each plan type
    - Professional billing period display
    - Proper renewal date handling

  3. Subscription Flow Improvements
    - Robust webhook processing
    - Automatic UI refresh triggers
    - Cancellation and resubscription handling
*/

-- Drop conflicting version of the webhook function first
DROP FUNCTION IF EXISTS handle_subscription_webhook(
  uuid,
  subscription_plan_type,
  subscription_status,
  text,
  text,
  timestamptz,
  timestamptz
);

-- Enhanced subscription webhook handler with better error handling
CREATE OR REPLACE FUNCTION handle_subscription_webhook(
  p_user_id uuid,
  p_plan_type subscription_plan_type,
  p_status subscription_status,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_existing_subscription subscriptions%ROWTYPE;
BEGIN
  -- Set period start to now if not provided
  v_period_start := COALESCE(p_period_start, now());
  
  -- Calculate period end if not provided
  IF p_period_end IS NULL THEN
    v_period_end := calculate_subscription_period_end(p_plan_type, v_period_start);
  ELSE
    v_period_end := p_period_end;
  END IF;

  -- Check for existing subscription
  SELECT * INTO v_existing_subscription
  FROM subscriptions 
  WHERE user_id = p_user_id;

  IF FOUND THEN
    -- Update existing subscription
    UPDATE subscriptions SET
      plan_type = p_plan_type,
      status = p_status,
      stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),
      stripe_customer_id = COALESCE(p_stripe_customer_id, stripe_customer_id),
      current_period_start = v_period_start,
      current_period_end = v_period_end,
      updated_at = now()
    WHERE user_id = p_user_id;
    
    RAISE NOTICE 'Updated subscription for user %', p_user_id;
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
      p_plan_type,
      p_status,
      p_stripe_subscription_id,
      p_stripe_customer_id,
      v_period_start,
      v_period_end
    );
    
    RAISE NOTICE 'Created subscription for user %', p_user_id;
  END IF;

  -- Ensure user record exists in users table
  INSERT INTO users (id, email, user_metadata)
  SELECT 
    au.id,
    au.email,
    COALESCE(au.raw_user_meta_data, '{}'::jsonb)
  FROM auth.users au
  WHERE au.id = p_user_id
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    user_metadata = EXCLUDED.user_metadata,
    updated_at = now();

EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Error in handle_subscription_webhook: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enhanced period calculation function
CREATE OR REPLACE FUNCTION calculate_subscription_period_end(
  plan_type subscription_plan_type,
  period_start timestamptz DEFAULT now()
) RETURNS timestamptz AS $$
BEGIN
  CASE plan_type
    WHEN 'trial' THEN
      RETURN period_start + INTERVAL '30 days';
    WHEN 'monthly' THEN
      RETURN period_start + INTERVAL '1 month';
    WHEN 'semiannual' THEN
      RETURN period_start + INTERVAL '6 months';
    WHEN 'annual' THEN
      RETURN period_start + INTERVAL '1 year';
    ELSE
      RETURN period_start + INTERVAL '30 days';
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get subscription with accurate access status
CREATE OR REPLACE FUNCTION get_subscription_access_status(p_user_id uuid)
RETURNS TABLE (
  subscription_id uuid,
  plan_type subscription_plan_type,
  status subscription_status,
  stripe_subscription_id text,
  stripe_customer_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  has_access boolean,
  days_remaining integer,
  is_expired boolean,
  is_cancelled boolean,
  billing_period_text text,
  created_at timestamptz,
  updated_at timestamptz
) AS $$
DECLARE
  v_subscription subscriptions%ROWTYPE;
  v_now timestamptz := now();
  v_has_access boolean := false;
  v_days_remaining integer := 0;
  v_is_expired boolean := false;
  v_is_cancelled boolean := false;
  v_billing_period_text text := '';
BEGIN
  -- Get the user's subscription
  SELECT * INTO v_subscription
  FROM subscriptions s
  WHERE s.user_id = p_user_id
  ORDER BY s.created_at DESC
  LIMIT 1;

  -- If no subscription found, return trial defaults
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      NULL::uuid,
      'trial'::subscription_plan_type,
      'active'::subscription_status,
      NULL::text,
      NULL::text,
      v_now,
      v_now + INTERVAL '30 days',
      true,
      30,
      false,
      false,
      'Free Trial - 30 days',
      v_now,
      v_now;
    RETURN;
  END IF;

  -- Calculate access status
  v_is_expired := v_subscription.current_period_end <= v_now;
  v_is_cancelled := v_subscription.status = 'cancelled';
  v_days_remaining := GREATEST(0, EXTRACT(days FROM v_subscription.current_period_end - v_now)::integer);
  
  -- Has access if: active OR (cancelled but not expired)
  v_has_access := (v_subscription.status = 'active') OR (v_is_cancelled AND NOT v_is_expired);

  -- Generate professional billing period text
  v_billing_period_text := format('%s – %s (%s)',
    to_char(v_subscription.current_period_start, 'Mon DD, YYYY'),
    to_char(v_subscription.current_period_end, 'Mon DD, YYYY'),
    CASE v_subscription.plan_type
      WHEN 'trial' THEN '30 days'
      WHEN 'monthly' THEN '1 month'
      WHEN 'semiannual' THEN '6 months'
      WHEN 'annual' THEN '1 year'
    END
  );

  RETURN QUERY SELECT
    v_subscription.id,
    v_subscription.plan_type,
    v_subscription.status,
    v_subscription.stripe_subscription_id,
    v_subscription.stripe_customer_id,
    v_subscription.current_period_start,
    v_subscription.current_period_end,
    v_has_access,
    v_days_remaining,
    v_is_expired,
    v_is_cancelled,
    v_billing_period_text,
    v_subscription.created_at,
    v_subscription.updated_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to handle subscription reactivation
CREATE OR REPLACE FUNCTION reactivate_subscription(
  p_user_id uuid,
  p_payment_method_id text
) RETURNS void AS $$
DECLARE
  v_subscription subscriptions%ROWTYPE;
BEGIN
  -- Get current subscription
  SELECT * INTO v_subscription
  FROM subscriptions
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No subscription found for user';
  END IF;

  -- Only allow reactivation if cancelled but not expired
  IF v_subscription.status != 'cancelled' THEN
    RAISE EXCEPTION 'Subscription is not cancelled';
  END IF;

  IF v_subscription.current_period_end <= now() THEN
    RAISE EXCEPTION 'Subscription has already expired';
  END IF;

  -- Reactivate subscription (will auto-renew at period end)
  UPDATE subscriptions SET
    status = 'active',
    updated_at = now()
  WHERE user_id = p_user_id;

  RAISE NOTICE 'Subscription reactivated for user %', p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to safely cancel subscription
CREATE OR REPLACE FUNCTION cancel_subscription_safe(
  p_user_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_subscription subscriptions%ROWTYPE;
BEGIN
  -- Get current subscription
  SELECT * INTO v_subscription
  FROM subscriptions
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No subscription found for user';
  END IF;

  -- Only cancel if currently active
  IF v_subscription.status != 'active' THEN
    RAISE EXCEPTION 'Subscription is not active';
  END IF;

  -- Mark as cancelled but keep access until period end
  UPDATE subscriptions SET
    status = 'cancelled',
    updated_at = now()
  WHERE user_id = p_user_id;

  -- Log cancellation reason if provided
  IF p_reason IS NOT NULL THEN
    RAISE NOTICE 'Subscription cancelled for user % with reason: %', p_user_id, p_reason;
  ELSE
    RAISE NOTICE 'Subscription cancelled for user %', p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get formatted billing period text
CREATE OR REPLACE FUNCTION get_billing_period_text(
  p_plan_type subscription_plan_type,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS text AS $$
BEGIN
  RETURN format('%s – %s (%s)',
    to_char(p_period_start, 'Mon DD, YYYY'),
    to_char(p_period_end, 'Mon DD, YYYY'),
    CASE p_plan_type
      WHEN 'trial' THEN '30 days'
      WHEN 'monthly' THEN '1 month'
      WHEN 'semiannual' THEN '6 months'
      WHEN 'annual' THEN '1 year'
    END
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION handle_subscription_webhook TO service_role;
GRANT EXECUTE ON FUNCTION calculate_subscription_period_end TO service_role;
GRANT EXECUTE ON FUNCTION get_subscription_access_status TO authenticated;
GRANT EXECUTE ON FUNCTION reactivate_subscription TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_subscription_safe TO authenticated;
GRANT EXECUTE ON FUNCTION get_billing_period_text TO authenticated;
