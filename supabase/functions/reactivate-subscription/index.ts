import Stripe from "npm:stripe@18.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.53.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface ReactivateRequest {
  paymentMethodId: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    // Get the user
    const {
      data: { user },
    } = await supabaseClient.auth.getUser();

    if (!user) {
      throw new Error('Unauthorized');
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
      apiVersion: '2023-10-16',
    });

    const { paymentMethodId }: ReactivateRequest = await req.json();

    console.log('🔄 Reactivating subscription for user:', user.id);

    // Get current subscription
    const { data: subscription, error: subError } = await supabaseClient
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (subError || !subscription) {
      throw new Error('No subscription found');
    }

    // Validate subscription can be reactivated
    if (subscription.status !== 'cancelled') {
      throw new Error('Subscription is not cancelled');
    }

    const now = new Date();
    const periodEnd = new Date(subscription.current_period_end);
    
    if (periodEnd <= now) {
      throw new Error('Subscription has already expired');
    }

    // If there's a Stripe subscription, reactivate it
    if (subscription.stripe_subscription_id) {
      console.log('🔄 Reactivating Stripe subscription:', subscription.stripe_subscription_id);
      
      // Update the subscription to not cancel at period end
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: false,
        default_payment_method: paymentMethodId,
        metadata: {
          user_id: user.id,
          plan_type: subscription.plan_type,
        }
      });

      console.log('✅ Stripe subscription reactivated');
    } else {
      // For one-time payments, we just need to set up future billing
      console.log('💳 Setting up future billing for one-time payment subscription');
      
      // Get or update customer's default payment method
      if (subscription.stripe_customer_id) {
        await stripe.customers.update(subscription.stripe_customer_id, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });
      }
    }

    // Update our database to mark as active
    const { error: updateError } = await supabaseClient.rpc('reactivate_subscription', {
      p_user_id: user.id,
      p_payment_method_id: paymentMethodId
    });

    if (updateError) {
      throw new Error(`Failed to reactivate subscription: ${updateError.message}`);
    }

    console.log('✅ Subscription reactivated successfully');

    return new Response(
      JSON.stringify({ 
        success: true,
        message: 'Subscription reactivated successfully'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('❌ Error reactivating subscription:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    );
  }
});