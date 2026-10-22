// First run and enrollment: the only screens that need the network before
// the register can work (docs/decisions/0010).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import type { Enrolled } from '../api/types';
import { openManagerSession } from '../auth/session';
import { db } from '../db/db';
import { isValidPin } from '../domain/pin';
import { nowIso } from '../sync/clock';

type Mode = 'checking' | 'unreachable' | 'setup' | 'enroll';

async function saveDevice(res: Enrolled): Promise<void> {
  await db.setMeta('device', { ...res.device, token: res.token });
}

export function SetupScreen() {
  const [mode, setMode] = useState<Mode>('checking');
  const [problem, setProblem] = useState('');

  const check = useCallback(async () => {
    setMode('checking');
    try {
      const res = await api<{ needsSetup: boolean }>('GET', '/setup');
      setMode(res.needsSetup ? 'setup' : 'enroll');
    } catch (e) {
      setProblem(errorMessage(e));
      setMode('unreachable');
    }
  }, []);
  useEffect(() => void check(), [check]);

  return (
    <div className="center-page">
      <div className="card">
        {mode === 'checking' && <p className="muted">Connecting…</p>}
        {mode === 'unreachable' && (
          <>
            <h1>Can't reach the server</h1>
            <p className="muted">
              Setting up a tablet needs a connection once. After that it works offline. ({problem})
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void check()}>
              Try again
            </button>
          </>
        )}
        {mode === 'setup' && <FirstRunForm />}
        {mode === 'enroll' && <EnrollForm />}
      </div>
    </div>
  );
}

function EnrollForm() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('Register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveDevice(await api<Enrolled>('POST', '/devices/enroll', { body: { code, name } }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>Add this tablet</h1>
      <p className="muted">A manager can create a code in Back office → Devices.</p>
      <div className="field">
        <label htmlFor="enroll-code">Enrollment code</label>
        <input id="enroll-code" className="input" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="enroll-name">Name this tablet</label>
        <input id="enroll-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Adding…' : 'Add tablet'}
      </button>
    </form>
  );
}

function FirstRunForm() {
  const [code, setCode] = useState('');
  const [managerName, setManagerName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [deviceName, setDeviceName] = useState('Register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isValidPin(pin)) return setError('Your PIN must be 4 to 8 digits.');
    if (pin !== pin2) return setError("The PINs don't match.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<Enrolled & { staff: { id: string } }>('POST', '/setup', {
        body: { code, managerName, pin, deviceName },
      });
      await saveDevice(res);
      // Whoever set the POS up is signed straight in.
      await db.setMeta('session', { staffId: res.staff.id, signedInAt: nowIso() });
      void openManagerSession(res.staff.id, pin);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>Set up your POS</h1>
      <p className="muted">The setup code is printed in the server's log the first time it starts.</p>
      <div className="field">
        <label htmlFor="setup-code">Setup code</label>
        <input id="setup-code" className="input" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="setup-name">Your name</label>
        <input id="setup-name" className="input" value={managerName} onChange={(e) => setManagerName(e.target.value)} maxLength={40} required />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="setup-pin">Choose a PIN (6+ digits recommended)</label>
          <input id="setup-pin" className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="setup-pin2">Repeat PIN</label>
          <input id="setup-pin2" className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(e.target.value)} required />
        </div>
      </div>
      <div className="field">
        <label htmlFor="setup-device">Name this tablet</label>
        <input id="setup-device" className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={40} required />
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Setting up…' : 'Set up'}
      </button>
    </form>
  );
}
