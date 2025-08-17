import Stripe from "npm:stripe@18.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.53.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, stripe-signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
      apiVersion: '2023-10-16',
    });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const signature = req.headers.get('stripe-signature');
    const body = await req.text();
    
    if (!signature) {
      console.error('❌ No Stripe signature found');
      return new Response('No signature', { status: 400 });
    }

    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      console.error('❌ No webhook secret configured');
      return new Response('Webhook secret not configured', { status: 500 });
    }

    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret
    );

    console.log(`🎯 Processing webhook event: ${event.type} at ${new Date().toISOString()}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log('💳 Checkout completed:', {
          sessionId: session.id,
          userId: session.metadata?.user_id,
          planType: session.metadata?.plan_type,
          customerId: session.customer,
          subscriptionId: session.subscription,
          mode: session.mode,
          paymentStatus: session.payment_status
        });
        
        if (session.metadata?.user_id && session.metadata?.plan_type && session.payment_status === 'paid') {
          const userId = session.metadata.user_id;
          const planType = session.metadata.plan_type as 'monthly' | 'semiannual' | 'annual';
          
          // Handle both subscription and payment modes
          const { error } = await supabase.rpc('handle_subscription_webhook', {
            p_user_id: userId,
            p_plan_type: planType,
            p_status: 'active',
            p_stripe_subscription_id: session.subscription as string || null,
            p_stripe_customer_id: session.customer as string,
            p_period_start: new Date().toISOString(),
            p_period_end: null // Function will calculate based on plan type
          });

          if (error) {
            console.error('❌ Error updating subscription via checkout:', error);
            throw error;
          } else {
            console.log('✅ Subscription updated successfully via checkout for user:', userId);
          }
        } else {
          console.warn('⚠️ Missing metadata or payment not completed in checkout session:', {
            metadata: session.metadata,
            paymentStatus: session.payment_status
          });
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log('💰 Payment intent succeeded:', {
          paymentIntentId: paymentIntent.id,
          userId: paymentIntent.metadata?.user_id,
          planType: paymentIntent.metadata?.plan_type,
          amount: paymentIntent.amount,
          customerId: paymentIntent.customer,
          status: paymentIntent.status
        });
        
        // Only process if this is a subscription payment (has metadata)
        if (paymentIntent.metadata?.user_id && paymentIntent.metadata?.plan_type) {
          const userId = paymentIntent.metadata.user_id;
          const planType = paymentIntent.metadata.plan_type as 'monthly' | 'semiannual' | 'annual';
          
          const { error } = await supabase.rpc('handle_subscription_webhook', {
            p_user_id: userId,
            p_plan_type: planType,
            p_status: 'active',
            p_stripe_subscription_id: null, // One-time payments don't have subscription IDs
            p_stripe_customer_id: paymentIntent.customer as string,
            p_period_start: new Date().toISOString(),
            p_period_end: null // Function will calculate based on plan type
          });

          if (error) {
            console.error('❌ Error updating subscription via payment intent:', error);
            throw error;
          } else {
            console.log('✅ Subscription updated successfully via payment intent for user:', userId);
          }
        } else {
          console.log('ℹ️ Payment intent without subscription metadata, skipping');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        console.log('📄 Invoice payment succeeded:', {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
          customerId: invoice.customer,
          amount: invoice.amount_paid,
          periodStart: invoice.period_start,
          periodEnd: invoice.period_end
        });
        
        if (invoice.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
            console.log('📋 Retrieved subscription details for invoice:', {
              subscriptionId: subscription.id,
              userId: subscription.metadata?.user_id,
              planType: subscription.metadata?.plan_type,
              status: subscription.status,
              currentPeriodStart: subscription.current_period_start,
              currentPeriodEnd: subscription.current_period_end
            });

            if (subscription.metadata?.user_id) {
              const { error } = await supabase.rpc('handle_subscription_webhook', {
                p_user_id: subscription.metadata.user_id,
                p_plan_type: (subscription.metadata.plan_type || 'monthly') as 'monthly' | 'semiannual' | 'annual',
                p_status: subscription.status === 'active' ? 'active' : 'past_due',
                p_stripe_subscription_id: subscription.id,
                p_stripe_customer_id: subscription.customer as string,
                p_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                p_period_end: new Date(subscription.current_period_end * 1000).toISOString()
              });

              if (error) {
                console.error('❌ Error updating subscription via invoice:', error);
                throw error;
              } else {
                console.log('✅ Subscription period updated successfully for invoice:', invoice.id);
              }
            }
          } catch (subscriptionError) {
            console.error('❌ Error retrieving subscription for invoice:', subscriptionError);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        console.log('❌ Invoice payment failed:', {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
          customerId: invoice.customer,
          amountDue: invoice.amount_due
        });
        
        if (invoice.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
            
            if (subscription.metadata?.user_id) {
              const { error } = await supabase.rpc('handle_subscription_webhook', {
                p_user_id: subscription.metadata.user_id,
                p_plan_type: (subscription.metadata.plan_type || 'monthly') as 'monthly' | 'semiannual' | 'annual',
                p_status: 'past_due',
                p_stripe_subscription_id: subscription.id,
                p_stripe_customer_id: subscription.customer as string,
                p_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                p_period_end: new Date(subscription.current_period_end * 1000).toISOString()
              });

              if (error) {
                console.error('❌ Error updating subscription status to past_due:', error);
              } else {
                console.log('✅ Subscription marked as past_due for invoice:', invoice.id);
              }
            }
          } catch (subscriptionError) {
            console.error('❌ Error retrieving subscription for failed invoice:', subscriptionError);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log('🔄 Subscription updated:', {
          subscriptionId: subscription.id,
          userId: subscription.metadata?.user_id,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: subscription.current_period_end
        });
        
        if (subscription.metadata?.user_id) {
          // Determine status based on Stripe subscription status
          let dbStatus: 'active' | 'cancelled' | 'past_due' = 'active';
          
          if (subscription.status === 'past_due') {
            dbStatus = 'past_due';
          } else if (subscription.cancel_at_period_end || subscription.status === 'canceled') {
            dbStatus = 'cancelled';
          }

          const { error } = await supabase.rpc('handle_subscription_webhook', {
            p_user_id: subscription.metadata.user_id,
            p_plan_type: (subscription.metadata.plan_type || 'monthly') as 'monthly' | 'semiannual' | 'annual',
            p_status: dbStatus,
            p_stripe_subscription_id: subscription.id,
            p_stripe_customer_id: subscription.customer as string,
            p_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            p_period_end: new Date(subscription.current_period_end * 1000).toISOString()
          });

          if (error) {
            console.error('❌ Error updating subscription via subscription.updated:', error);
          } else {
            console.log('✅ Subscription updated successfully via subscription.updated:', subscription.id);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log('🗑️ Subscription deleted:', {
          subscriptionId: subscription.id,
          userId: subscription.metadata?.user_id,
          customerId: subscription.customer
        });
        
        if (subscription.metadata?.user_id) {
          const { error } = await supabase.rpc('handle_subscription_webhook', {
            p_user_id: subscription.metadata.user_id,
            p_plan_type: (subscription.metadata.plan_type || 'monthly') as 'monthly' | 'semiannual' | 'annual',
            p_status: 'cancelled',
            p_stripe_subscription_id: subscription.id,
            p_stripe_customer_id: subscription.customer as string,
            p_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            p_period_end: new Date(subscription.current_period_end * 1000).toISOString()
          });

          if (error) {
            console.error('❌ Error cancelling subscription:', error);
          } else {
            console.log('✅ Subscription cancelled successfully:', subscription.id);
          }
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled webhook event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ 
      received: true, 
      processed: true,
      event_type: event.type,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    console.error('💥 Webhook processing error:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      event_type: 'unknown',
      timestamp: new Date().toISOString()
    }), { 
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});