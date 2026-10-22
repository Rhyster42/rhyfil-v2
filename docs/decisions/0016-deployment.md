# 16. One container serves the API and the PWA

Status: accepted · 2026-10-22

## Decision

- A multi-stage Dockerfile builds the web app (Node) and the server (Go) and
  produces a distroless image containing the binary and the static files. The
  API and the app share an origin: no CORS, and a simple service-worker scope.
- docker compose runs Postgres 18 and the app. Demo data and a reusable demo
  enrollment code are on by default for local runs.
- Service workers need HTTPS except on `localhost`. An optional `lan` compose
  profile adds Caddy with an internal certificate authority, for testing on
  real tablets.

## Alternatives rejected

- **An nginx container for static files.** Another moving part with no
  benefit at this scale.
- **Embedding the web build in the Go binary.** Every Go build and test would
  need the web build first, or a build tag and placeholder files.
