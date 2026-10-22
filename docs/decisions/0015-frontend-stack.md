# 15. Frontend: React, TypeScript, Vite, Dexie

Status: accepted · 2026-10-22

## Decision

- React and TypeScript, built with Vite. One app serves both the register and
  the back office.
- Dexie over IndexedDB, with live queries so screens re-render when sync writes
  new data.
- vite-plugin-pwa (Workbox) precaches the app shell. Updates download in the
  background and are applied only when no order is open.
- Plain CSS with custom properties and no component library. Touch targets are
  at least 56 px.
- A small hash router written in-house; no router library.

## Alternatives rejected

- **Svelte, Preact or Solid.** All fine and smaller, but bundle size barely
  matters for an installed PWA, and React's testing ecosystem is the most
  mature.
- **htmx with Go templates.** Every interaction needs the server, so it can't
  work offline.
- **Redux or Zustand.** The open order is a pure reducer, and persisted data
  lives in Dexie. There's no third kind of state to manage.
