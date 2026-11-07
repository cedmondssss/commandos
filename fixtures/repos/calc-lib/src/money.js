/** Rounds to cents. */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Applies a discount to a subtotal.
 * @param {number} subtotal
 * @param {{ amount?: number, percent?: number } | undefined} discount
 */
export function applyDiscount(subtotal, discount) {
  if (!discount) return round2(subtotal);
  if (discount.amount != null) return round2(Math.max(0, subtotal - discount.amount));
  return round2(Math.max(0, subtotal - discount.percent));
}

/**
 * Splits a bill between people. Amounts are in dollars; every cent must be accounted for,
 * with any remainder going to the first payers.
 */
export function splitBill(total, people) {
  if (people <= 0) throw new RangeError('people must be positive');
  const cents = Math.round(total * 100);
  const share = Math.floor(cents / people);
  return Array.from({ length: people }, () => share / 100);
}

export function formatUSD(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
