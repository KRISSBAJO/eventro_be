/** Simple, explainable risk scoring for new orders. Each rule adds points and a reason. */

export type FraudInput = {
  email: string;
  totalCents: number;
  quantity: number;
  maxPerOrder: number;
  recentOrdersSameEmail: number; // last 10 minutes
  recentOrdersSameIp: number; // last 10 minutes
  secondsToCheckout: number | null; // hold created -> order placed
};

const DISPOSABLE = ['tempmail', 'mailinator', 'guerrillamail', '10minutemail', 'throwaway', 'yopmail', 'trashmail'];

export function scoreOrder(i: FraudInput): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, r: string) => {
    score += n;
    reasons.push(r);
  };

  const domain = i.email.split('@')[1]?.toLowerCase() ?? '';
  if (DISPOSABLE.some((d) => domain.includes(d))) add(35, 'Disposable email domain');
  if (i.recentOrdersSameEmail >= 3) add(30, `${i.recentOrdersSameEmail} orders from this email in 10 minutes`);
  if (i.recentOrdersSameIp >= 5) add(30, `${i.recentOrdersSameIp} orders from this IP address in 10 minutes`);
  if (i.secondsToCheckout !== null && i.secondsToCheckout < 4) add(25, `Checkout finished in ${i.secondsToCheckout.toFixed(1)} seconds`);
  if (i.quantity >= i.maxPerOrder) add(10, 'Maximum tickets per order');
  if (i.totalCents >= 100_000) add(10, 'Order over $1,000');

  return { score: Math.min(100, score), reasons };
}

export const FRAUD_FLAG_THRESHOLD = 50;
