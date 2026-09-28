/** Format an amount in integer cents as a price string. */
export function formatPrice(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}
