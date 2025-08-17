import { supabase } from '../lib/supabase';

export interface Subscription {
  id: string;
  user_id: string;
  plan_type: 'trial' | 'monthly' | 'semiannual' | 'annual';
  status: 'active' | 'expired' | 'cancelled' | 'past_due';
  stripe_subscription_id?: string;
  stripe_customer_id?: string;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
}

export interface PlanFeatures {
  maxCustomers: number;
  maxBranches: number;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  customBranding: boolean;
  apiAccess: boolean;
}

export interface SubscriptionAccessStatus {
  hasAccess: boolean;
  subscription: Subscription | null;
  features: PlanFeatures;
  daysRemaining?: number;
  isExpired?: boolean;
  isCancelled?: boolean;
  billingPeriodText?: string;
}

export class SubscriptionService {
  static async createSubscription(
    userId: string,
    planType: 'trial' | 'monthly' | 'semiannual' | 'annual',
    stripeSubscriptionId?: string,
    stripeCustomerId?: string
  ): Promise<Subscription> {
    try {
      console.log('🔄 Creating/updating subscription:', { userId, planType, stripeSubscriptionId, stripeCustomerId });

      // Use the enhanced webhook handler for consistency
      const { error } = await supabase.rpc('handle_subscription_webhook', {
        p_user_id: userId,
        p_plan_type: planType,
        p_status: 'active',
        p_stripe_subscription_id: stripeSubscriptionId || null,
        p_stripe_customer_id: stripeCustomerId || null,
        p_period_start: new Date().toISOString(),
        p_period_end: null // Function will calculate
      });

      if (error) {
        console.error('❌ Error in createSubscription:', error);
        throw new Error(`Failed to create subscription: ${error.message}`);
      }

      // Fetch the created/updated subscription
      const subscription = await this.getUserSubscription(userId);
      if (!subscription) {
        throw new Error('Failed to retrieve created subscription');
      }

      console.log('✅ Subscription created/updated successfully:', subscription.id);
      return subscription;
    } catch (error: any) {
      console.error('💥 Error in createSubscription:', error);
      throw error;
    }
  }

  static async updateSubscription(
    subscriptionId: string,
    planType: 'trial' | 'monthly' | 'semiannual' | 'annual',
    stripeSubscriptionId?: string,
    stripeCustomerId?: string
  ): Promise<Subscription> {
    try {
      console.log('🔄 Updating subscription:', { subscriptionId, planType });

      // Get current subscription to get user_id
      const { data: currentSub, error: fetchError } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('id', subscriptionId)
        .single();

      if (fetchError || !currentSub) {
        throw new Error('Subscription not found');
      }

      // Use webhook handler for consistency
      const { error } = await supabase.rpc('handle_subscription_webhook', {
        p_user_id: currentSub.user_id,
        p_plan_type: planType,
        p_status: 'active',
        p_stripe_subscription_id: stripeSubscriptionId || null,
        p_stripe_customer_id: stripeCustomerId || null,
        p_period_start: new Date().toISOString(),
        p_period_end: null
      });

      if (error) {
        throw new Error(`Failed to update subscription: ${error.message}`);
      }

      const updatedSubscription = await this.getUserSubscription(currentSub.user_id);
      if (!updatedSubscription) {
        throw new Error('Failed to retrieve updated subscription');
      }

      return updatedSubscription;
    } catch (error: any) {
      console.error('💥 Error in updateSubscription:', error);
      throw error;
    }
  }

  static async getUserSubscription(userId: string): Promise<Subscription | null> {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error('❌ Error fetching subscription:', error);
        return null;
      }

      return data;
    } catch (error: any) {
      console.error('💥 Error in getUserSubscription:', error);
      return null;
    }
  }

  static async updateSubscriptionStatus(
    subscriptionId: string,
    status: 'active' | 'expired' | 'cancelled' | 'past_due'
  ): Promise<void> {
    try {
      const { error } = await supabase
        .from('subscriptions')
        .update({ 
          status,
          updated_at: new Date().toISOString()
        })
        .eq('id', subscriptionId);

      if (error) {
        throw new Error(`Failed to update subscription status: ${error.message}`);
      }

      console.log('✅ Subscription status updated:', { subscriptionId, status });
    } catch (error: any) {
      console.error('💥 Error updating subscription status:', error);
      throw error;
    }
  }

  static async cancelSubscription(userId: string, reason?: string): Promise<void> {
    try {
      console.log('🚫 Cancelling subscription for user:', userId);

      const { error } = await supabase.rpc('cancel_subscription_safe', {
        p_user_id: userId,
        p_reason: reason || null
      });

      if (error) {
        throw new Error(`Failed to cancel subscription: ${error.message}`);
      }

      console.log('✅ Subscription cancelled successfully');
    } catch (error: any) {
      console.error('💥 Error cancelling subscription:', error);
      throw error;
    }
  }

  static async reactivateSubscription(userId: string, paymentMethodId: string): Promise<void> {
    try {
      console.log('🔄 Reactivating subscription for user:', userId);

      const { error } = await supabase.rpc('reactivate_subscription', {
        p_user_id: userId,
        p_payment_method_id: paymentMethodId
      });

      if (error) {
        throw new Error(`Failed to reactivate subscription: ${error.message}`);
      }

      console.log('✅ Subscription reactivated successfully');
    } catch (error: any) {
      console.error('💥 Error reactivating subscription:', error);
      throw error;
    }
  }

  static async checkSubscriptionAccess(userId: string): Promise<SubscriptionAccessStatus> {
    try {
      console.log('🔍 Checking subscription access for user:', userId);

      // Use the enhanced database function for accurate status
      const { data, error } = await supabase.rpc('get_subscription_access_status', {
        p_user_id: userId
      });

      if (error) {
        console.error('❌ Error checking subscription access:', error);
        // Fallback to basic access for error cases
        return this.getFallbackAccess();
      }

      if (!data || data.length === 0) {
        console.log('📊 No subscription data found, providing trial access');
        return this.getFallbackAccess();
      }

      const subscriptionData = data[0];
      
      const result: SubscriptionAccessStatus = {
        hasAccess: subscriptionData.has_access,
        subscription: {
          id: subscriptionData.subscription_id,
          user_id: userId,
          plan_type: subscriptionData.plan_type,
          status: subscriptionData.status,
          stripe_subscription_id: subscriptionData.stripe_subscription_id,
          stripe_customer_id: subscriptionData.stripe_customer_id,
          current_period_start: subscriptionData.current_period_start,
          current_period_end: subscriptionData.current_period_end,
          created_at: subscriptionData.created_at,
          updated_at: subscriptionData.updated_at
        },
        features: this.getPlanFeatures(subscriptionData.plan_type),
        daysRemaining: subscriptionData.days_remaining,
        isExpired: subscriptionData.is_expired,
        isCancelled: subscriptionData.is_cancelled,
        billingPeriodText: subscriptionData.billing_period_text
      };

      console.log('✅ Subscription access checked:', {
        hasAccess: result.hasAccess,
        planType: result.subscription?.plan_type,
        status: result.subscription?.status,
        daysRemaining: result.daysRemaining,
        isExpired: result.isExpired,
        isCancelled: result.isCancelled
      });

      return result;
    } catch (error: any) {
      console.error('💥 Error in checkSubscriptionAccess:', error);
      return this.getFallbackAccess();
    }
  }

  private static getFallbackAccess(): SubscriptionAccessStatus {
    const now = new Date();
    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

    return {
      hasAccess: true,
      subscription: null,
      features: this.getTrialFeatures(),
      daysRemaining: 30,
      isExpired: false,
      isCancelled: false,
      billingPeriodText: `${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (30 days)`
    };
  }

  static getPlanFeatures(planType: 'trial' | 'monthly' | 'semiannual' | 'annual'): PlanFeatures {
    switch (planType) {
      case 'trial':
        return this.getTrialFeatures();
      case 'monthly':
        return {
          maxCustomers: -1, // Unlimited
          maxBranches: -1, // Unlimited
          advancedAnalytics: true,
          prioritySupport: true,
          customBranding: false,
          apiAccess: false
        };
      case 'semiannual':
        return {
          maxCustomers: -1, // Unlimited
          maxBranches: -1, // Unlimited
          advancedAnalytics: true,
          prioritySupport: true,
          customBranding: true,
          apiAccess: true
        };
      case 'annual':
        return {
          maxCustomers: -1, // Unlimited
          maxBranches: -1, // Unlimited
          advancedAnalytics: true,
          prioritySupport: true,
          customBranding: true,
          apiAccess: true
        };
      default:
        return this.getTrialFeatures();
    }
  }

  private static getTrialFeatures(): PlanFeatures {
    return {
      maxCustomers: 100,
      maxBranches: 1,
      advancedAnalytics: false,
      prioritySupport: false,
      customBranding: false,
      apiAccess: false
    };
  }

  // Trigger UI refresh across all components
  static triggerSubscriptionUpdate(): void {
    console.log('🔄 Triggering subscription update event');
    
    // Dispatch multiple events to ensure all components refresh
    window.dispatchEvent(new CustomEvent('subscription-updated'));
    window.dispatchEvent(new CustomEvent('billing-updated'));
    window.dispatchEvent(new CustomEvent('subscription-refresh'));
    
    // Also trigger a storage event for cross-tab communication
    localStorage.setItem('subscription-update-timestamp', Date.now().toString());
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'subscription-update-timestamp',
      newValue: Date.now().toString()
    }));
  }

  // Enhanced subscription stats for admin
  static async getSubscriptionStats(): Promise<{
    total: number;
    active: number;
    trial: number;
    paid: number;
    revenue: number;
    churnRate: number;
  }> {
    try {
      const { data: subscriptions, error } = await supabase
        .from('subscriptions')
        .select('plan_type, status');

      if (error) throw error;

      const total = subscriptions?.length || 0;
      const active = subscriptions?.filter(s => s.status === 'active').length || 0;
      const trial = subscriptions?.filter(s => s.plan_type === 'trial').length || 0;
      const paid = subscriptions?.filter(s => s.plan_type !== 'trial' && s.status === 'active').length || 0;
      const cancelled = subscriptions?.filter(s => s.status === 'cancelled').length || 0;
      
      // Calculate total revenue generated
      const totalRevenue = subscriptions?.reduce((sum, sub) => {
        if (sub.status === 'active' || sub.status === 'expired' || sub.status === 'cancelled') {
          if (sub.plan_type === 'monthly') return sum + 2.99;
          if (sub.plan_type === 'semiannual') return sum + 9.99;
          if (sub.plan_type === 'annual') return sum + 19.99;
        }
        return sum;
      }, 0) || 0;
      
      const churnRate = total > 0 ? (cancelled / total) * 100 : 0;

      return { total, active, trial, paid, revenue: totalRevenue, churnRate };
    } catch (error: any) {
      console.error('Error fetching subscription stats:', error);
      return {
        total: 0,
        active: 0,
        trial: 0,
        paid: 0,
        revenue: 0,
        churnRate: 0
      };
    }
  }

  static async getAllSubscriptions(): Promise<(Subscription & { 
    user_email?: string;
    restaurant_name?: string;
  })[]> {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select(`
          *,
          user:users(email),
          restaurant:restaurants(name)
        `)
        .order('created_at', { ascending: false });
        
      if (error) throw error;
      
      return (data || []).map(sub => ({
        ...sub,
        user_email: sub.user?.email || 'Unknown',
        restaurant_name: sub.restaurant?.name || 'Unknown Restaurant'
      }));
    } catch (error: any) {
      console.error('Error fetching all subscriptions:', error);
      return [];
    }
  }

  static async getSystemWideStats(): Promise<{
    totalRevenue: number;
    totalCustomers: number;
    totalRestaurants: number;
    totalTransactions: number;
    monthlyGrowth: number;
  }> {
    try {
      const [restaurantCount, customerCount, transactionCount] = await Promise.all([
        supabase.from('restaurants').select('*', { count: 'exact', head: true }),
        supabase.from('customers').select('*', { count: 'exact', head: true }),
        supabase.from('transactions').select('*', { count: 'exact', head: true })
      ]);
      
      // Calculate total revenue from customer spending
      const { data: customers } = await supabase
        .from('customers')
        .select('total_spent');
      
      const totalRevenue = customers?.reduce((sum, c) => sum + parseFloat(c.total_spent?.toString() || '0'), 0) || 0;
      
      // Calculate monthly growth
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      
      const { data: recentCustomers } = await supabase
        .from('customers')
        .select('created_at')
        .gte('created_at', lastMonth.toISOString());
      
      const monthlyGrowth = customerCount.count && customerCount.count > 0 
        ? ((recentCustomers?.length || 0) / customerCount.count) * 100 
        : 0;

      return {
        totalRevenue,
        totalCustomers: customerCount.count || 0,
        totalRestaurants: restaurantCount.count || 0,
        totalTransactions: transactionCount.count || 0,
        monthlyGrowth
      };
    } catch (error: any) {
      console.error('Error fetching system-wide stats:', error);
      return {
        totalRevenue: 0,
        totalCustomers: 0,
        totalRestaurants: 0,
        totalTransactions: 0,
        monthlyGrowth: 0
      };
    }
  }
}