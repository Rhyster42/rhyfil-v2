// The tablet's estimate of server time (docs/decisions/0013). Every pull
// measures the offset; documents are stamped with corrected time.
let offsetMs = 0;

export function setClockOffset(ms: number): void {
  offsetMs = ms;
}

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

export function nowIso(): string {
  return now().toISOString();
}
