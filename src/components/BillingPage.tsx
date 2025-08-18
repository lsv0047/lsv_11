import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  CreditCard, Calendar, DollarSign, Crown, AlertTriangle, 
  CheckCircle, Clock, RefreshCw, Plus, Trash2, Star,
  Download, Eye, Settings, ArrowRight, X, Shield,
  Loader2, AlertCircle as AlertIcon, Info, Target,
  Building, Users, TrendingUp, BarChart3
} from 'lucide-react';
import { SubscriptionService } from '../services/subscriptionService';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

interface PaymentMethod {
  id: string;
  type: string;
  card?: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  };
  is_default: boolean;
}

const BillingPage: React.FC = () => {
  const [subscriptionData, setSubscriptionData] = useState<any>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showReactivateModal, setShowReactivateModal] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [reactivateLoading, setReactivateLoading] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<string>('');
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) {
      loadBillingData();
    }
  }, [user]);

  // Listen for subscription updates
  useEffect(() => {
    const handleBillingUpdate = () => {
      console.log('🔄 Billing update event received, refreshing billing data...');
      loadBillingData(true); // Force refresh
    };

    const handleStorageUpdate = (e: StorageEvent) => {
      if (e.key === 'subscription-update-timestamp') {
        console.log('🔄 Storage update event received, refreshing billing data...');
        loadBillingData(true);
      }
    };

    window.addEventListener('subscription-updated', handleBillingUpdate);
    window.addEventListener('billing-updated', handleBillingUpdate);
    window.addEventListener('subscription-refresh', handleBillingUpdate);
    window.addEventListener('storage', handleStorageUpdate);
    
    return () => {
      window.removeEventListener('subscription-updated', handleBillingUpdate);
      window.removeEventListener('billing-updated', handleBillingUpdate);
      window.removeEventListener('subscription-refresh', handleBillingUpdate);
      window.removeEventListener('storage', handleStorageUpdate);
    };
  }, []);

  const loadBillingData = async (forceRefresh: boolean = false) => {
    if (!user) return;

    try {
      setLoading(true);
      setError('');

      // Force refresh subscription data
      const data = await SubscriptionService.checkSubscriptionAccess(user.id);
      console.log('💳 Billing data loaded:', data);
      setSubscriptionData(data);

      // Load payment methods if customer exists
      if (data.subscription?.stripe_customer_id) {
        await loadPaymentMethods(data.subscription.stripe_customer_id);
      }
    } catch (err: any) {
      console.error('Error loading billing data:', err);
      setError(err.message || 'Failed to load billing information');
    } finally {
      setLoading(false);
    }
  };

  const loadPaymentMethods = async (customerId: string) => {
    try {
      setPaymentMethodsLoading(true);
      
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-payment-methods`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customerId })
      });

      if (!response.ok) {
        throw new Error('Failed to load payment methods');
      }

      const { paymentMethods: methods } = await response.json();
      setPaymentMethods(methods || []);
    } catch (err: any) {
      console.error('Error loading payment methods:', err);
    } finally {
      setPaymentMethodsLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!subscriptionData?.subscription) return;

    try {
      setCancelLoading(true);
      await SubscriptionService.cancelSubscription(user!.id, 'User requested cancellation');
      
      // Refresh billing data
      await loadBillingData(true);
      setShowCancelModal(false);
      
      // Trigger app-wide refresh
      window.dispatchEvent(new CustomEvent('subscription-updated'));
      window.dispatchEvent(new CustomEvent('billing-updated'));
    } catch (err: any) {
      console.error('Error cancelling subscription:', err);
      setError(err.message || 'Failed to cancel subscription');
    } finally {
      setCancelLoading(false);
    }
  };

  const handleReactivateSubscription = async () => {
    if (!selectedPaymentMethod || !subscriptionData?.subscription) return;

    try {
      setReactivateLoading(true);
      
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reactivate-subscription`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          paymentMethodId: selectedPaymentMethod 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to reactivate subscription');
      }

      // Refresh billing data
      await loadBillingData(true);
      setShowReactivateModal(false);
      setSelectedPaymentMethod('');
      
      // Trigger app-wide refresh
      window.dispatchEvent(new CustomEvent('subscription-updated'));
      window.dispatchEvent(new CustomEvent('billing-updated'));
    } catch (err: any) {
      console.error('Error reactivating subscription:', err);
      setError(err.message || 'Failed to reactivate subscription');
    } finally {
      setReactivateLoading(false);
    }
  };

  const getPlanDisplayName = (planType: string) => {
    switch (planType) {
      case 'trial': return 'Free Trial';
      case 'monthly': return 'Monthly Plan';
      case 'semiannual': return '6-Month Plan';
      case 'annual': return 'Annual Plan';
      default: return 'Unknown Plan';
    }
  };

  const getPlanPrice = (planType: string) => {
    switch (planType) {
      case 'trial': return '$0';
      case 'monthly': return '$2.99/month';
      case 'semiannual': return '$9.99 (6 months)';
      case 'annual': return '$19.99 (1 year)';
      default: return 'Unknown';
    }
  };

  const getStatusColor = (status: string, isExpired: boolean, isCancelled: boolean) => {
    if (isExpired) return 'bg-red-100 text-red-800 border-red-200';
    if (isCancelled) return 'bg-orange-100 text-orange-800 border-orange-200';
    if (status === 'active') return 'bg-green-100 text-green-800 border-green-200';
    if (status === 'past_due') return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    return 'bg-gray-100 text-gray-800 border-gray-200';
  };

  const getStatusText = (status: string, isExpired: boolean, isCancelled: boolean) => {
    if (isExpired) return 'Expired';
    if (isCancelled) return 'Cancelled';
    if (status === 'active') return 'Active';
    if (status === 'past_due') return 'Past Due';
    return status;
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-64 mb-4"></div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-64 bg-gray-200 rounded-2xl"></div>
            <div className="h-64 bg-gray-200 rounded-2xl"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Billing & Subscription</h1>
          <p className="text-gray-600">Manage your subscription and payment methods</p>
        </div>
        <button
          onClick={() => loadBillingData(true)}
          className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          title="Refresh Billing Data"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-3">
          <AlertIcon className="h-5 w-5" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Current Plan */}
        <div className="bg-white rounded-2xl p-6 border border-gray-200">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Crown className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Current Plan</h2>
              <p className="text-sm text-gray-500">Your active subscription details</p>
            </div>
          </div>

          {subscriptionData?.subscription ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Plan</span>
                <span className="font-semibold text-gray-900">
                  {getPlanDisplayName(subscriptionData.subscription.plan_type)}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Status</span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusColor(
                  subscriptionData.subscription.status,
                  subscriptionData.isExpired,
                  subscriptionData.isCancelled
                )}`}>
                  {getStatusText(
                    subscriptionData.subscription.status,
                    subscriptionData.isExpired,
                    subscriptionData.isCancelled
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Plan Expires</span>
                <span className="font-semibold text-gray-900">
                  {new Date(subscriptionData.subscription.current_period_end).toLocaleDateString('en-US', {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Billing Period</span>
                <span className="font-semibold text-gray-900 text-right">
                  {subscriptionData.billingPeriodText || 'Not available'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Days Remaining</span>
                <span className={`font-semibold ${
                  subscriptionData.daysRemaining <= 7 ? 'text-red-600' : 'text-gray-900'
                }`}>
                  {subscriptionData.daysRemaining} days
                </span>
              </div>

              {/* Action Buttons */}
              <div className="pt-4 border-t border-gray-200 space-y-3">
                {subscriptionData.subscription.plan_type === 'trial' && (
                  <button
                    onClick={() => navigate('/upgrade')}
                    className="w-full bg-gradient-to-r from-[#E6A85C] via-[#E85A9B] to-[#D946EF] text-white py-3 px-4 rounded-xl hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2"
                  >
                    <Crown className="h-4 w-4" />
                    Upgrade Plan
                  </button>
                )}

                {subscriptionData.isCancelled && !subscriptionData.isExpired && (
                  <button
                    onClick={() => setShowReactivateModal(true)}
                    className="w-full bg-green-600 text-white py-3 px-4 rounded-xl hover:bg-green-700 transition-colors flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Reactivate Subscription
                  </button>
                )}

                {!subscriptionData.isCancelled && !subscriptionData.isExpired && subscriptionData.subscription.plan_type !== 'trial' && (
                  <button
                    onClick={() => setShowCancelModal(true)}
                    className="w-full border border-red-200 text-red-600 py-3 px-4 rounded-xl hover:bg-red-50 transition-colors"
                  >
                    Cancel Subscription
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <Crown className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">No active subscription</p>
              <button
                onClick={() => navigate('/upgrade')}
                className="px-6 py-3 bg-gradient-to-r from-[#E6A85C] via-[#E85A9B] to-[#D946EF] text-white rounded-xl hover:shadow-lg transition-all duration-200"
              >
                Choose a Plan
              </button>
            </div>
          )}
        </div>

        {/* Payment Methods */}
        <div className="bg-white rounded-2xl p-6 border border-gray-200">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
                <CreditCard className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Payment Methods</h2>
                <p className="text-sm text-gray-500">Manage your payment options</p>
              </div>
            </div>
            <button
              onClick={() => navigate('/upgrade')}
              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              title="Add Payment Method"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          {paymentMethodsLoading ? (
            <div className="text-center py-8">
              <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
              <p className="text-gray-500">Loading payment methods...</p>
            </div>
          ) : paymentMethods.length === 0 ? (
            <div className="text-center py-8">
              <CreditCard className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">No payment methods added</p>
              <button
                onClick={() => navigate('/upgrade')}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Add Payment Method
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {paymentMethods.map((method) => (
                <div
                  key={method.id}
                  className={`p-4 border rounded-xl transition-all ${
                    method.is_default 
                      ? 'border-blue-200 bg-blue-50' 
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                        <CreditCard className="h-5 w-5 text-gray-600" />
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">
                          {method.card?.brand.toUpperCase()} •••• {method.card?.last4}
                        </p>
                        <p className="text-sm text-gray-500">
                          Expires {method.card?.exp_month}/{method.card?.exp_year}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {method.is_default && (
                        <span className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded-full font-medium">
                          Default
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Billing History */}
      <div className="bg-white rounded-2xl p-6 border border-gray-200">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
            <Calendar className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Billing History</h2>
            <p className="text-sm text-gray-500">Download invoices and view payment history</p>
          </div>
        </div>

        {subscriptionData?.subscription ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Date</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Amount</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Period</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-3 px-4 text-gray-900">
                    {new Date(subscriptionData.subscription.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </td>
                  <td className="py-3 px-4 font-semibold text-gray-900">
                    {getPlanPrice(subscriptionData.subscription.plan_type).split(' ')[0]}
                  </td>
                  <td className="py-3 px-4">
                    <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                      Paid
                    </span>
                  </td>
                  <td className="py-3 px-4 text-gray-600 text-sm">
                    {new Date(subscriptionData.subscription.current_period_start).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    })} - {new Date(subscriptionData.subscription.current_period_end).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </td>
                  <td className="py-3 px-4">
                    <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
                      <Download className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8">
            <Calendar className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No billing history available</p>
          </div>
        )}
      </div>

      {/* Plan Features */}
      <div className="bg-white rounded-2xl p-6 border border-gray-200">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center">
            <Star className="h-6 w-6 text-yellow-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Plan Features</h2>
            <p className="text-sm text-gray-500">What's included in your current plan</p>
          </div>
        </div>

        {subscriptionData?.features && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <Users className="h-5 w-5 text-blue-600" />
              <div>
                <p className="font-medium text-gray-900">Customers</p>
                <p className="text-sm text-gray-600">
                  {subscriptionData.features.maxCustomers === -1 ? 'Unlimited' : subscriptionData.features.maxCustomers}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <Building className="h-5 w-5 text-green-600" />
              <div>
                <p className="font-medium text-gray-900">Branches</p>
                <p className="text-sm text-gray-600">
                  {subscriptionData.features.maxBranches === -1 ? 'Unlimited' : subscriptionData.features.maxBranches}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <BarChart3 className="h-5 w-5 text-purple-600" />
              <div>
                <p className="font-medium text-gray-900">Advanced Analytics</p>
                <p className="text-sm text-gray-600">
                  {subscriptionData.features.advancedAnalytics ? 'Included' : 'Not included'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <Shield className="h-5 w-5 text-indigo-600" />
              <div>
                <p className="font-medium text-gray-900">Priority Support</p>
                <p className="text-sm text-gray-600">
                  {subscriptionData.features.prioritySupport ? 'Included' : 'Not included'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Cancel Subscription Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-gray-900">Cancel Subscription</h3>
              <button
                onClick={() => setShowCancelModal(false)}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                  <div>
                    <p className="font-medium text-yellow-900 mb-1">Important</p>
                    <p className="text-yellow-800 text-sm">
                      Your subscription will be cancelled but you'll continue to have access until{' '}
                      <strong>
                        {new Date(subscriptionData.subscription.current_period_end).toLocaleDateString('en-US', {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </strong>
                      . You can reactivate anytime before then.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl p-4">
                <h4 className="font-medium text-gray-900 mb-2">What happens when you cancel:</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Your subscription will not auto-renew</li>
                  <li>• You keep access until your billing period ends</li>
                  <li>• You can reactivate anytime before expiration</li>
                  <li>• No immediate charges or penalties</li>
                </ul>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCancelModal(false)}
                className="flex-1 py-3 px-4 border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
              >
                Keep Subscription
              </button>
              <button
                onClick={handleCancelSubscription}
                disabled={cancelLoading}
                className="flex-1 py-3 px-4 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {cancelLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Cancel Subscription'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reactivate Subscription Modal */}
      {showReactivateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-gray-900">Reactivate Subscription</h3>
              <button
                onClick={() => setShowReactivateModal(false)}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                  <div>
                    <p className="font-medium text-green-900 mb-1">Reactivate Your Plan</p>
                    <p className="text-green-800 text-sm">
                      Your subscription will automatically renew on{' '}
                      <strong>
                        {new Date(subscriptionData.subscription.current_period_end).toLocaleDateString('en-US', {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </strong>
                      . No charges until then.
                    </p>
                  </div>
                </div>
              </div>

              {paymentMethods.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Payment Method
                  </label>
                  <div className="space-y-2">
                    {paymentMethods.map((method) => (
                      <label
                        key={method.id}
                        className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-all ${
                          selectedPaymentMethod === method.id
                            ? 'border-blue-200 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="paymentMethod"
                          value={method.id}
                          checked={selectedPaymentMethod === method.id}
                          onChange={(e) => setSelectedPaymentMethod(e.target.value)}
                          className="text-blue-600"
                        />
                        <CreditCard className="h-4 w-4 text-gray-600" />
                        <span className="text-sm font-medium text-gray-900">
                          {method.card?.brand.toUpperCase()} •••• {method.card?.last4}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {paymentMethods.length === 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-blue-800 text-sm">
                    You'll need to add a payment method to reactivate your subscription.
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowReactivateModal(false)}
                className="flex-1 py-3 px-4 border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              {paymentMethods.length > 0 ? (
                <button
                  onClick={handleReactivateSubscription}
                  disabled={reactivateLoading || !selectedPaymentMethod}
                  className="flex-1 py-3 px-4 bg-green-600 text-white rounded-xl hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {reactivateLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4" />
                      Reactivate
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={() => navigate('/upgrade')}
                  className="flex-1 py-3 px-4 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
                >
                  Add Payment Method
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BillingPage;