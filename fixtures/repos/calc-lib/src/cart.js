import { applyDiscount, round2 } from './money.js';

/** Totals line items and applies an optional discount code. */
export function cartTotal(items, discount) {
  const subtotal = round2(items.reduce((sum, i) => sum + i.price * i.qty, 0));
  return applyDiscount(subtotal, discount);
}
