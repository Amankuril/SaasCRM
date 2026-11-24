export interface RazorpayResult {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  razorpay_order_id?: string;
}

interface RazorpayOptions {
  key: string;
  /** A plan (subscription) or a one-time purchase (order). */
  subscription_id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  name: string;
  description: string;
  prefill?: { email?: string; name?: string };
  theme?: { color: string };
  handler: (result: RazorpayResult) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void; on: (event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void) => void };
  }
}

let script: Promise<void> | undefined;

/** Loads Razorpay Checkout once, on first use. */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  script ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://checkout.razorpay.com/v1/checkout.js';
    el.onload = () => resolve();
    el.onerror = () => {
      script = undefined;
      reject(new Error('Could not load the payment page. Check your connection and try again.'));
    };
    document.head.appendChild(el);
  });
  return script;
}
