import { formatMoney } from '../domain/money';

interface KeypadProps {
  /** Cents. Digits shift in from the right, like a till: 5, 0, 0 → $5.00. */
  value: number;
  onChange: (cents: number) => void;
  max?: number;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'];

export function Keypad({ value, onChange, max = 99_999_99 }: KeypadProps) {
  const press = (k: string) => {
    const next = Number(`${value}${k}`);
    if (next <= max) onChange(next);
  };
  return (
    <div className="keypad">
      <output className="keypad-display" aria-label="Amount">
        {formatMoney(value)}
      </output>
      <div className="pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="pin-key" onClick={() => press(k)}>
            {k}
          </button>
        ))}
        <button type="button" className="pin-key pin-key-muted" aria-label="Delete digit" onClick={() => onChange(Math.floor(value / 10))}>
          ⌫
        </button>
      </div>
    </div>
  );
}
