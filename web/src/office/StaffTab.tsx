import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { engine } from '../app/services';
import { isValidPin } from '../domain/pin';
import { Sheet } from '../ui/Sheet';
import { officeApi, useOffice } from './officeApi';
import type { StaffAccount } from './types';

type Editing = { kind: 'new' } | { kind: 'edit'; person: StaffAccount } | null;

function StaffForm({ editing, onDone }: { editing: Exclude<Editing, null>; onDone: () => void }) {
  const person = editing.kind === 'edit' ? editing.person : null;
  const [name, setName] = useState(person?.name ?? '');
  const [role, setRole] = useState<StaffAccount['role']>(person?.role ?? 'barista');
  const [active, setActive] = useState(person?.active ?? true);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if ((!person || pin) && !isValidPin(pin)) return setError('PINs are 4 to 8 digits.');
    setBusy(true);
    setError(null);
    try {
      if (person) {
        await officeApi('PATCH', `/staff/${person.id}`, { name, role, active, ...(pin ? { pin } : {}) });
      } else {
        await officeApi('POST', '/staff', { name, role, pin });
      }
      // Tablets pick up the change on their next sync; this one, now.
      void engine.syncNow();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={person ? `Edit ${person.name}` : 'Add a person'} onClose={onDone}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="staff-name">Name</label>
          <input id="staff-name" className="input" value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="label">Role</span>
          <div className="segmented" role="radiogroup" aria-label="Role">
            {(['barista', 'manager'] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} aria-selected={role === r} onClick={() => setRole(r)}>
                {r === 'barista' ? 'Barista' : 'Manager'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="staff-pin">{person ? 'New PIN (leave blank to keep)' : 'PIN (4–8 digits; 6+ for managers)'}</label>
          <input id="staff-pin" className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
        </div>
        {person && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Can sign in
          </label>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </Sheet>
  );
}

/** Who can sign in, and as what (docs/decisions/0010). */
export function StaffTab() {
  const { data, error, reload } = useOffice<StaffAccount[]>('/staff');
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <div className="office-page">
      <div className="filter-row">
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ kind: 'new' })}>
          Add a person
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.role === 'manager' ? 'Manager' : 'Barista'}</td>
                <td>{p.active ? 'Can sign in' : <span className="muted">Deactivated</span>}</td>
                <td className="num">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing({ kind: 'edit', person: p })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <StaffForm
          editing={editing}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
