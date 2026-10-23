import { useState } from 'react';
import { errorMessage } from '../api/client';
import { useMeta } from '../db/db';
import { Sheet } from '../ui/Sheet';
import { officeApi, useOffice } from './officeApi';
import type { DeviceStatus, Rejection } from './types';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Enrolled tablets, enrollment codes, and documents the server refused. */
export function DevicesTab() {
  const thisDevice = useMeta('device');
  const devices = useOffice<DeviceStatus[]>('/devices');
  const rejections = useOffice<Rejection[]>('/sync/rejections');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [removing, setRemoving] = useState<DeviceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function newCode() {
    setError(null);
    try {
      setCode(await officeApi<{ code: string; expiresAt: string }>('POST', '/devices/codes'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove(d: DeviceStatus) {
    setError(null);
    try {
      await officeApi('POST', `/devices/${d.id}/revoke`);
      setRemoving(null);
      devices.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="office-page">
      <div className="filter-row">
        <button type="button" className="btn btn-primary" onClick={() => void newCode()}>
          Add a tablet
        </button>
      </div>
      {(error ?? devices.error) && <p className="error-text" role="alert">{error ?? devices.error}</p>}
      {devices.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Tablet</th>
              <th>Last synced</th>
              <th className="num">Not sent</th>
              <th className="num">Open orders</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.data.map((d) => (
              <tr key={d.id} className={d.revokedAt ? 'muted' : undefined}>
                <td>
                  {d.name} <span className="muted">({d.code})</span>
                  {d.id === thisDevice?.id && <span className="badge">This tablet</span>}
                </td>
                <td>{d.revokedAt ? 'Removed' : ago(d.lastSeenAt)}</td>
                <td className="num">{d.revokedAt ? '' : d.reportedPending}</td>
                <td className="num">{d.revokedAt ? '' : d.reportedOpen}</td>
                <td className="num">
                  {!d.revokedAt && d.id !== thisDevice?.id && (
                    <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setRemoving(d)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Refused by the server</h3>
      <p className="muted">Documents a tablet sent that couldn't be stored, usually because of an app bug. The tablet keeps its copy.</p>
      {rejections.data && rejections.data.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Tablet</th>
              <th>What</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rejections.data.map((r) => (
              <tr key={r.id}>
                <td>{ago(r.receivedAt)}</td>
                <td>
                  {r.deviceName} ({r.deviceCode})
                </td>
                <td>
                  {r.kind} <span className="muted">{r.docId.slice(0, 8)}</span>
                </td>
                <td>{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        rejections.data && <p className="muted">None.</p>
      )}

      {code && (
        <Sheet title="Add a tablet" onClose={() => setCode(null)}>
          <p>On the new tablet, open this app and enter:</p>
          <p className="big-code" aria-label="Enrollment code">
            {code.code}
          </p>
          <p className="muted">Works once, until {new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
          <button type="button" className="btn btn-block" onClick={() => setCode(null)}>
            Done
          </button>
        </Sheet>
      )}
      {removing && (
        <Sheet title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>It stops syncing immediately and can't be used until it's enrolled again.</p>
          {removing.reportedPending > 0 && (
            <p className="status status-warn">
              <span aria-hidden="true">⚠</span> It last reported {removing.reportedPending} documents it hasn't sent. They'll be stranded on the tablet.
            </p>
          )}
          <button type="button" className="btn btn-danger btn-block" onClick={() => void remove(removing)}>
            Remove tablet
          </button>
        </Sheet>
      )}
    </div>
  );
}
