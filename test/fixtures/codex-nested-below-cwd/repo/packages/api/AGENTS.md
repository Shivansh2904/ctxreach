# API package

## API conventions

- Handlers live in src/handlers and return typed results, never raw responses.
- Every handler validates its input with the shared schema helpers.
- Keep handler files under 300 lines; split by resource when they grow.
- Name routes after resources, not actions: /invoices, not /createInvoice.
- Return 404 for a missing resource and 403 for one the caller may not see.

## Error handling

- Wrap third-party errors in ApiError with a stable code before rethrowing.
- Never include stack traces or SQL in an error body.
- Log the request id with every error so support can find it.
- Retries belong in the client, not in the handler.

## Testing

- Each handler has a test that covers the success path and one failure.
- Use the in-memory store in tests; never hit the real database.
- Snapshot tests are not allowed for JSON bodies; assert the fields you care about.

## Payments

- Never call the payments provider API directly. Go through PaymentsClient in src/payments.
- Amounts are integer cents. Reject any request that sends a float.
- Every payment call carries an idempotency key taken from the request id.
