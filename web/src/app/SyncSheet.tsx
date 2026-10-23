import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { findManagerByPin } from '../auth/session';
import { db, useMeta } from '../db/db';
import type { OrderDoc } from '../domain/documents';
import { PinPad } from '../ui/PinPad';
import { Sheet } from '../ui/Sheet';
import { engine } from './services';

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * What the sync engine is doing: what's waiting, and anything the server
 * refused. Rejected documents are never dropped silently (docs/decisions/0003);
 * clearing them takes a manager.
 */
export function SyncSheet({ onClose }: { onClose: () => void }) {
  const status = useMeta('syncStatus');
  const outbox = useLiveQuery(() => db.outbox.orderBy('seq').toArray(), []) ?? [];
  const rejected = useLiveQuery(() => db.deadLetters.toArray(), []) ?? [];
  const [approving, setApproving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function syncNow() {
    setBusy(true);
    await engine.syncNow();
    setBusy(false);
  }

  return (
    <Sheet title="Sync" onClose={onClose}>
      <dl className="facts">
        <dt>Connection</dt>
        <dd>{status?.state === 'offline' ? 'Offline' : status?.state === 'unauthorized' ? 'Device removed' : status?.state === 'error' ? 'Server problem' : 'Online'}</dd>
        <dt>Last synced</dt>
        <dd>{ago(status?.lastSyncAt)}</dd>
        <dt>Waiting to send</dt>
        <dd>{outbox.length ? `${outbox.length} (oldest ${ago(outbox[0]?.createdAt)})` : 'Nothing'}</dd>
      </dl>
      {status?.lastError && status.state !== 'idle' && <p className="error-text">{status.lastError}</p>}
      <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void syncNow()}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>

      {rejected.length > 0 && (
        <section className="rejected">
          <h3>Refused by the server ({rejected.length})</h3>
          <p className="muted">
            These can't be stored as they are, usually because of an app bug. Download them for whoever supports your POS. They stay here until a manager clears them.
          </p>
          <ul>
            {rejected.map((d) => (
              <li key={d.id}>
                <strong>{d.kind === 'order' ? `Order ${(d.doc as OrderDoc).number}` : 'Refund'}</strong>: {d.error}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => download('rejected-documents.json', rejected)}>
              Download
            </button>
            <button type="button" className="btn btn-danger-outline" onClick={() => setApproving(true)}>
              Clear…
            </button>
          </div>
        </section>
      )}

      {approving && (
        <Sheet onClose={() => setApproving(false)}>
          <PinPad
            title="Manager approval"
            hint="Clear the refused documents"
            check={async (pin) => !!(await findManagerByPin(pin))}
            onAccept={() => {
              void db.deadLetters.clear();
              setApproving(false);
            }}
            onCancel={() => setApproving(false)}
          />
        </Sheet>
      )}
    </Sheet>
  );
}
