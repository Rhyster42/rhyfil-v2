import { useEffect, useRef, useState } from 'react';

interface PinPadProps {
  title: string;
  hint?: string;
  /**
   * Checks a PIN: true accepts, false is a wrong PIN, a string is any other
   * problem to show. Unless auto is false, it's tried quietly once 4+ digits
   * are in, so short PINs need no OK tap.
   */
  check: (pin: string) => Promise<boolean | string>;
  onAccept: (pin: string) => void;
  onCancel?: () => void;
  /** Off when each check costs something (a server round trip that counts failures). */
  auto?: boolean;
}

const MAX_LENGTH = 8;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function PinPad({ title, hint, check, onAccept, onCancel, auto = true }: PinPadProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Only the newest check may act; typing another digit supersedes it.
  const attempt = useRef(0);
  const done = useRef(false);

  async function tryPin(value: string, explicit: boolean) {
    const n = ++attempt.current;
    if (explicit) setChecking(true);
    const result = await check(value);
    if (n !== attempt.current || done.current) return;
    setChecking(false);
    if (result === true) {
      done.current = true;
      onAccept(value);
    } else if (explicit) {
      setError(result === false ? 'Wrong PIN' : result);
      setPin('');
    }
  }

  function press(digit: string) {
    if (pin.length >= MAX_LENGTH || done.current) return;
    const next = pin + digit;
    setError(null);
    setPin(next);
    if (auto && next.length >= 4) void tryPin(next, false);
  }

  function back() {
    attempt.current++;
    setPin(pin.slice(0, -1));
  }

  function submit() {
    if (pin.length < 4) {
      setError('PINs are at least 4 digits');
      return;
    }
    void tryPin(pin, true);
  }

  const latest = useRef({ press, back, submit, onCancel });
  latest.current = { press, back, submit, onCancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = latest.current;
      if (/^[0-9]$/.test(e.key)) k.press(e.key);
      else if (e.key === 'Backspace') k.back();
      else if (e.key === 'Enter') k.submit();
      else if (e.key === 'Escape') k.onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="pinpad">
      <h2 className="pinpad-title">{title}</h2>
      {hint && <p className="muted pinpad-hint">{hint}</p>}
      <div className={`pin-dots${error ? ' shake' : ''}`} aria-label={`${pin.length} digits entered`} role="status">
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span key={i} className={`pin-dot${i < pin.length ? ' filled' : ''}`} />
        ))}
      </div>
      <p className="error-text pin-error" role="alert">
        {error ?? ' '}
      </p>
      <div className="pin-keys">
        {KEYS.map((d) => (
          <button key={d} type="button" className="pin-key" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="pin-key pin-key-muted" onClick={onCancel} disabled={!onCancel}>
          Cancel
        </button>
        <button type="button" className="pin-key" onClick={() => press('0')}>
          0
        </button>
        <button type="button" className="pin-key pin-key-muted" onClick={back} aria-label="Delete digit">
          ⌫
        </button>
      </div>
      <button type="button" className="btn btn-primary btn-block" onClick={submit} disabled={checking}>
        {checking ? 'Checking…' : 'OK'}
      </button>
    </div>
  );
}
