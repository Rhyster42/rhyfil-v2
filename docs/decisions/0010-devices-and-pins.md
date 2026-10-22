# 10. Enrolled devices and staff PINs

Status: accepted · 2026-10-22

## Decision

- **Devices.** A tablet is enrolled once with a one-time code that a manager
  creates (valid 15 minutes). Enrollment returns a random 256-bit device token;
  the server stores only its SHA-256 hash. Every API call from the tablet
  carries the token.
- **First run.** While there are no staff, the server prints a setup code to
  its log. Using it creates the first manager and enrolls that device.
- **Staff.** Staff sign in on an enrolled tablet by tapping their name and
  entering a 4–8 digit PIN. Every document records the staff member, the
  device and, for refunds, the approving manager.
- **PIN verifiers** are PBKDF2-SHA256 strings
  (`pbkdf2-sha256$<iterations>$<salt>$<hash>`), which WebCrypto and Go's
  standard library can both compute. Tablets receive the verifiers of active
  staff, so sign-in and manager approvals work offline.
- **Back office.** It needs an online manager session. The server checks the
  PIN (locking out after repeated failures) and issues a 12-hour session token
  bound to that device.

## Alternatives rejected

- **Usernames and passwords, or OAuth/SSO.** Slow at the counter, and they
  don't work offline.
- **Checking PINs only on the server.** No sign-in or approvals offline.

## Consequences (accepted risk)

- PIN verifiers live on the tablet. Someone with the tablet and developer tools
  could brute-force a 4-digit PIN. PINs are for attribution, not a security
  boundary; the control is per-person reporting of voids, reversals and
  refunds. Managers should use PINs of 6 or more digits.
- The device token is the real credential. A lost tablet is revoked from the
  back office.
