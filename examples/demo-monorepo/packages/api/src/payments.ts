import { PaymentsClient } from "./payments-client.js";

/** Charge a customer. Amounts are integer cents. */
export async function charge(client: PaymentsClient, customerId: string, amountCents: number, requestId: string) {
  if (!Number.isInteger(amountCents)) throw new Error("amount must be integer cents");
  return client.charge({ customerId, amountCents, idempotencyKey: requestId });
}
