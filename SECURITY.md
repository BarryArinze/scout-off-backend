# Security Policy

## Supported Versions

We release security patches for the latest version of the ScoutOff backend.
Older versions are not guaranteed to receive backports.

| Version | Supported          |
| ------- | ------------------ |
| latest  | ✅ Yes             |
| older   | ❌ No              |

## Reporting a Vulnerability

**Do NOT open a public GitHub Issue for security vulnerabilities.** GitHub
Issues are publicly visible — posting exploit details before a fix is deployed
puts all ScoutOff users at risk.

### Private Disclosure Process

1. **Email the maintainers** at the address listed on the
   [ScoutOff GitHub profile](https://github.com/scout-off) or in the repository's
   `package.json` `"author"` field.
2. **Include the following in your report:**
   - A clear description of the vulnerability and the affected component.
   - Steps to reproduce or a proof-of-concept (share only if it is safe to do
     so over email — do not attach live exploit code).
   - The potential impact (data exposure, auth bypass, denial of service, etc.).
   - Your suggested fix, if you have one.
3. **Allow 7 days** for an initial response before any public disclosure.
   We aim to acknowledge reports within 48 hours and provide a resolution
   timeline within 7 days.

### What to Expect

| Timeline     | Action                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| 0–48 hours   | Acknowledgement of receipt                                                |
| 0–7 days     | Initial severity assessment and resolution timeline communicated to you   |
| 7–30 days    | Patch developed and reviewed (timeline depends on severity and complexity) |
| After patch  | Coordinated public disclosure with credit to the reporter (if desired)    |

We follow a coordinated disclosure model. We will credit reporters in the
release notes unless you prefer to remain anonymous.

## Scope

The following are **in scope** for security reports:

- Authentication and authorisation bypasses (SEP-10, JWT, role checks)
- SQL injection or data exposure in API endpoints
- Rate-limiting bypasses that could enable denial-of-service
- Privilege escalation (e.g. a player acting as a validator or admin)
- Secrets or sensitive data leaked in logs or API responses
- Supply-chain vulnerabilities in direct production dependencies

The following are **out of scope**:

- Vulnerabilities in the Stellar network or Soroban runtime itself (report
  those to the [Stellar Bug Bounty Program](https://www.stellar.org/bug-bounty-program))
- Issues requiring physical access to the server
- Social engineering attacks against maintainers or users
- Bugs in development-only dependencies (devDependencies) with no production impact

## Security Best Practices for Contributors

Before submitting a pull request:

```bash
npm audit              # check all dependencies
npm audit --omit=dev   # check production dependencies only
```

See [CONTRIBUTING.md — Security & Dependency Review](CONTRIBUTING.md#security--dependency-review)
for the full checklist.

## Acknowledgements

We thank all responsible security researchers who help keep ScoutOff safe.
Reporters who follow this policy will be credited in the relevant release notes
(unless they request anonymity).
