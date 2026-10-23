import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import type { Settings } from '../api/types';
import { engine } from '../app/services';
import { MoneyInput } from '../ui/MoneyInput';
import { officeApi, useOffice } from './officeApi';

const zones: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

const cutoffs = Array.from({ length: 25 }, (_, i) => i * 30); // midnight to noon

function timeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

export function SettingsTab() {
  const { data, error } = useOffice<Settings>('/settings');
  const [form, setForm] = useState<Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setMessage(null);
    setSaveError(null);
    try {
      setForm(await officeApi<Settings>('PUT', '/settings', form));
      void engine.syncNow();
      setMessage('Saved. Tablets pick this up on their next sync.');
    } catch (err) {
      setSaveError(errorMessage(err));
    }
  }

  if (error) return <p className="error-text office-page">{error}</p>;
  if (!form) return null;
  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  return (
    <form className="office-page settings-form" onSubmit={save}>
      <div className="field">
        <label htmlFor="set-name">Store name</label>
        <input id="set-name" className="input" value={form.storeName} maxLength={60} onChange={(e) => set({ storeName: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="set-tz">Time zone</label>
        {zones.length ? (
          <select id="set-tz" className="input" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        ) : (
          <input id="set-tz" className="input" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} />
        )}
      </div>
      <div className="field">
        <label htmlFor="set-cutoff">The business day starts at</label>
        <select id="set-cutoff" className="input" value={form.dayCutoffMinutes} onChange={(e) => set({ dayCutoffMinutes: Number(e.target.value) })}>
          {cutoffs.map((m) => (
            <option key={m} value={m}>
              {timeLabel(m)}
            </option>
          ))}
        </select>
        <span className="muted">Sales before this time count toward the previous day.</span>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="set-currency">Currency</label>
          <input id="set-currency" className="input" value={form.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
        </div>
        <div className="field">
          <label htmlFor="set-float">Usual drawer float</label>
          <MoneyInput id="set-float" label="Usual drawer float" value={form.defaultFloat} onChange={(v) => set({ defaultFloat: v })} />
        </div>
      </div>
      {saveError && <p className="error-text" role="alert">{saveError}</p>}
      {message && <p className="ok-text" role="status">{message}</p>}
      <button type="submit" className="btn btn-primary">
        Save settings
      </button>
      <p className="muted">The sales tax rate is part of the menu, so each order keeps the rate it was sold with.</p>
    </form>
  );
}
