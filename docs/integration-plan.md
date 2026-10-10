# Integration Plan

## Goal

Connect Bitrix24 Cloud with Ameriabank Corporate API so Bitrix users can initiate and track banking-related operations from Bitrix workflows or app UI.

## Main Modules

1. Bitrix24 app authentication
   - OAuth callback endpoint.
   - Token persistence layer.
   - REST client for Bitrix24 webhooks or app auth.
   - Current local build supports inbound webhook mode through `BITRIX_WEBHOOK_URL`.

2. Ameriabank Corporate API client
   - Authentication/token flow.
   - Account and balance queries.
   - Payment initiation/status endpoints.
   - Error mapping for user-friendly Bitrix messages.

3. Backend integration layer
   - Express API.
   - Request validation.
   - Audit logging.
   - Idempotency for payment-like operations.

4. React dashboard
   - Connection status.
   - API health checks.
   - Manual sync/test actions.
   - Operation history.

## Next Decisions

- Confirm exact Ameriabank authentication parameters from the PDF specification.
- Bitrix24 mode is inbound webhook for now; public app OAuth can be added later if needed.
- Choose database for token and operation storage.
