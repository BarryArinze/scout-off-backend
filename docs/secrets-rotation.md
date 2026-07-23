# Secrets Rotation Policy and Procedures

This document outlines the rotation policy, cadence, and step-by-step procedures for every long-lived secret used by the ScoutOff backend. Managing and rotating these secrets on a defined schedule is critical to preserving the security and integrity of the platform.

---

## Documented Secrets Summary

| Secret | Cadence | Zero-Downtime? | Responsibility |
|---|---|---|---|
| `JWT_SECRET` | Quarterly (90 days) | Yes (via Dual-Key) | Security Administrator |
| `PINATA_API_KEY` / `PINATA_SECRET` | Semi-Annually (180 days) | No (Requires Restart) | DevOps / IPFS Administrator |
| `PLATFORM_SECRET_KEY` / `PLATFORM_SECRET` | Semi-Annually (180 days) | No (Requires Restart) | Key Custodian / Soroban Admin |
| `ADMIN_WALLET` / `ADMIN_WALLETS` | Annually (365 days) | No (Requires Restart) | Platform Owner / Multi-Sig Signers |
| `REDIS_URL` (with password) | Annually (365 days) | No (Requires Restart) | Database / DevOps Engineer |

---

## 1. JWT Signer Secret (`JWT_SECRET`)

The backend issues JSON Web Tokens (JWTs) to authenticate players, scouts, validators, and administrators. 

* **Recommended Cadence**: Quarterly (every 90 days), or immediately upon suspected compromise.
* **Responsible Party**: Security Administrator.
* **Downtime Impact**: **Zero-Downtime Supported.** A dual-key mechanism is supported natively by the authentication middleware to transition active sessions.

### Rotation Procedure

To rotate the JWT secret without disrupting active users, follow the instructions documented in the auth section of the environment configuration:

1. **Staging the Transition**:
   - Copy the current value of `JWT_SECRET` into `JWT_SECRET_PREVIOUS`.
   - Generate a new cryptographically secure secret (minimum 32 characters).
     ```bash
     openssl rand -hex 32
     ```
   - Update `JWT_SECRET` to the new generated value.
2. **First Deployment**:
   - Deploy the new configuration and perform a rolling update of the service.
   - The server will sign all new JWTs with the new `JWT_SECRET`, but will continue to accept active tokens signed with the old secret (via `JWT_SECRET_PREVIOUS`).
3. **Transition Window**:
   - Leave both secrets active for a transition period equal to the maximum token lifetime (e.g., 24 hours).
4. **Final Deprecation**:
   - Once all old sessions have expired, clear `JWT_SECRET_PREVIOUS` from the environment.
   - Perform a final rolling update of the service. Tokens signed with the old secret will now be rejected.

---

## 2. Pinata IPFS Credentials (`PINATA_API_KEY` / `PINATA_SECRET`)

Used by the backend to pin player and metadata files to IPFS via Pinata's API.

* **Recommended Cadence**: Semi-Annually (every 180 days), or immediately upon suspected compromise.
* **Responsible Party**: DevOps / IPFS Administrator.
* **Downtime Impact**: **Downtime Required (Brief).** Changing these credentials requires a restart of the backend service to load the new config.

> [!WARNING]
> While a rolling update minimizes service interruption, any file-upload or pinning requests that occur during the environment update may fail until the new credentials take effect.

### Rotation Procedure

1. **Generate New Keypair**:
   - Log in to the [Pinata Dashboard](https://app.pinata.cloud/).
   - Navigate to the **API Keys** section.
   - Click **New Key** and grant the required permissions (typically `pinFileToIPFS`, `pinJSONToIPFS`, and `unpin`).
   - Copy the newly generated **API Key** and **Secret API Key**.
2. **Apply Configuration**:
   - Update the `PINATA_API_KEY` and `PINATA_SECRET` environment variables in your deployment hosting provider (e.g. AWS, Render, Heroku).
3. **Service Restart**:
   - Deploy or restart the backend application.
4. **Verify Connectivity**:
   - Check the `/ready` endpoint, which triggers an IPFS readiness check.
   - Verify that log entries do not report IPFS service connection warnings.
5. **Revoke Old Keypair**:
   - Go back to the Pinata Dashboard and delete/revoke the old API Key.

---

## 3. Platform Signing Keypairs (`PLATFORM_SECRET_KEY` / `PLATFORM_SECRET`)

Stellar secret keys used by the backend to sign transactions/messages and execute Soroban contract invocations (such as subscription cancellations or contract pausing).

* **Recommended Cadence**: Semi-Annually (every 180 days), or immediately upon suspected compromise.
* **Responsible Party**: Key Custodian / Soroban Admin.
* **Downtime Impact**: **Downtime Required.** Rotating the platform keys requires service restarts.

> [!IMPORTANT]
> Because these keys submit transactions directly to the Stellar network, the newly generated key must be funded with native XLM before deployment to prevent transaction execution failures.

### Rotation Procedure

1. **Generate a New Keypair**:
   - Generate a new Stellar account using the Stellar CLI:
     ```bash
     stellar keys generate --network testnet platform-new
     ```
     *(Or use standard BIP-39 generators for mainnet).*
   - Note the public key (starts with `G`) and secret seed (starts with `S`).
2. **Fund the Account**:
   - **Testnet**: Fund the public key via Friendbot:
     ```bash
     curl "https://friendbot.stellar.org?addr=<NEW_PUBLIC_KEY>"
     ```
   - **Mainnet**: Manually transfer sufficient native token (XLM) to the new public key to cover gas/transaction fees.
3. **Update Configuration**:
   - Update `PLATFORM_SECRET_KEY` and `PLATFORM_SECRET` in the environment variables with the new Stellar secret seed.
4. **Deploy & Restart**:
   - Perform a rolling restart of the backend service.
5. **Verify Submissions**:
   - Monitor the logs for successful indexer updates and verify that on-chain contract actions succeed without throwing signature or fee errors.

---

## 4. Admin Wallet Configuration (`ADMIN_WALLET` / `ADMIN_WALLETS`)

Stellar public addresses configured on the backend to authorize high-value administrative commands (e.g., fee withdrawals or pausing the contract). Note that the backend only holds the public addresses; the corresponding private keys remain secure on the administrators' personal devices.

* **Recommended Cadence**: Annually (365 days), or immediately if any admin key is suspected to be compromised.
* **Responsible Party**: Platform Owner / Multi-Sig Signers.
* **Downtime Impact**: **Downtime Required.** A service restart is required to load the updated admin list.

### Rotation Procedure

1. **Obtain New Admin Addresses**:
   - Identify the new administrator public keys (Stellar G-addresses).
2. **Update Environment**:
   - Update `ADMIN_WALLET` and `ADMIN_WALLETS` in the environment configuration.
   - For multi-sig deployment, specify multiple comma-separated addresses and adjust `ADMIN_THRESHOLD` accordingly.
3. **Restart the Application**:
   - Apply the changes and restart the backend service.
4. **Verify Authorization**:
   - Verify that new admins can authenticate using SEP-10 and access admin routes (e.g. `GET /api/admin/fees`).
   - Confirm that revoked admin addresses are rejected with `403` or `401` on those endpoints.

---

## 5. Redis Database URL (`REDIS_URL`)

The connection string for the optional Redis cache, which may contain sensitive credentials (e.g., `redis://:password@host:port`).

* **Recommended Cadence**: Annually (365 days), or immediately upon suspected compromise.
* **Responsible Party**: Database / DevOps Engineer.
* **Downtime Impact**: **Downtime Required (Brief).** A server restart is required to update the connection pool config.

### Rotation Procedure

1. **Generate New Redis Credentials**:
   - Log in to your Redis provider and generate a new password or access credential.
2. **Update Environment**:
   - Construct the new connection URL:
     `redis://:<NEW_PASSWORD>@<HOST>:<PORT>`
   - Update the `REDIS_URL` environment variable.
3. **Restart the Service**:
   - Perform a rolling restart of the backend application.
4. **Verify Connectivity**:
   - Ensure no Redis connection errors are logged during startup.
5. **Deprecate Old Credentials**:
   - Revoke the old password on the Redis database server.

---

## Known Gaps and Limitations

### Webhook Signing Secrets
The backend's webhook dispatcher **does** sign outgoing payloads with an HMAC-SHA256 signature
sent in the `X-Webhook-Signature` header.  Each subscription row in `webhook_subscriptions` holds
its own per-subscriber secret generated at creation.

**Current limitation**: There is no dedicated API endpoint to rotate a subscription's secret
without deleting and re-creating the subscription.  See
[docs/webhooks.md § Secret Rotation](webhooks.md#secret-rotation) for the current workaround and
the planned `POST /api/admin/webhooks/:id/rotate-secret` improvement.

* **Follow-up Action**: Once the rotation endpoint ships, update both this document and
  `docs/webhooks.md` to document zero-downtime dual-secret rotation (analogous to the
  `JWT_SECRET_PREVIOUS` pattern).
