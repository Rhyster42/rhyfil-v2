import { useEffect, useState } from 'react';

interface MoneyInputProps {
  /** Cents. */
  value: number;
  onChange: (cents: number) => void;
  label: string;
  /** Allow a leading minus (modifier price changes). */
  signed?: boolean;
  id?: string;
  className?: string;
}

function toText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function parse(text: string, signed: boolean): number | null {
  const m = (signed ? /^\s*(-)?\$?(\d{1,7})(?:\.(\d{0,2}))?\s*$/ : /^\s*()\$?(\d{1,7})(?:\.(\d{0,2}))?\s*$/).exec(text);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** A dollars-and-cents field that reports cents, and flags text it can't read. */
export function MoneyInput({ value, onChange, label, signed = false, id, className }: MoneyInputProps) {
  const [text, setText] = useState(toText(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    // Follow changes from outside (a reset), not the ones typing made.
    if (parse(text, signed) !== value) setText(toText(value));
  }, [value]);
  return (
    <input
      id={id}
      className={`input money-input${bad ? ' input-bad' : ''}${className ? ` ${className}` : ''}`}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={bad}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const cents = parse(e.target.value, signed);
        setBad(cents === null);
        if (cents !== null) onChange(cents);
      }}
      onBlur={() => !bad && setText(toText(value))}
    />
  );
}
