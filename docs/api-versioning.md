## API Versioning Policy

Decision: `/api/v2` is intended to be a near-parity surface with `/api/v1` by
default. Divergence is permitted but must be deliberate, documented, and
machine-checkable.

Mechanics:

- Any route present under `/api/v1` is expected to also be present under
  `/api/v2` unless it is explicitly listed in the parity allowlist.
- Deliberate differences (v2-only routes or v2 response-shape changes) must
  be documented in this file and added to `src/config/apiVersioning.ts` so
  the automated parity test can ignore them.

Rationale: This ensures accidental omissions (e.g., failing to copy a new
endpoint into v2) are caught by CI while still allowing planned API evolution.

Example allowed divergence:

- `/api/v2/versioning/demo` — a deliberately v2-only demo endpoint used to
  exercise the parity testing machinery.
