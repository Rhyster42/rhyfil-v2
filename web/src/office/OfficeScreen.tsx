import type { Route } from '../app/route';
import { useMeta } from '../db/db';
import { businessDate } from '../domain/businessDate';
import { now } from '../sync/clock';
import { CloseoutTab } from './CloseoutTab';
import { DevicesTab } from './DevicesTab';
import { FlagsTab } from './FlagsTab';
import { ManagerGate } from './ManagerGate';
import { MenuTab } from './MenuTab';
import { ReportsTab } from './ReportsTab';
import { SettingsTab } from './SettingsTab';
import { StaffTab } from './StaffTab';

const TABS = [
  ['reports', 'Reports'],
  ['closeout', 'Close-out'],
  ['flags', 'Flags'],
  ['menu', 'Menu'],
  ['staff', 'Staff'],
  ['devices', 'Tablets'],
  ['settings', 'Settings'],
] as const;

/** Online-only manager tools (docs/decisions/0001). */
export function OfficeScreen({ staffId, tab, navigate }: { staffId: string; tab: string; navigate: (r: Route) => void }) {
  const settings = useMeta('settings');
  const today = settings ? businessDate(now(), settings.timezone, settings.dayCutoffMinutes) : null;
  const go = (t: string) => navigate({ screen: 'office', tab: t });
  return (
    <ManagerGate staffId={staffId}>
      <div className="office">
        <nav className="office-tabs" aria-label="Back office">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => go(t)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="office-body">
          {tab === 'reports' && today && <ReportsTab today={today} onReviewFlags={() => go('flags')} />}
          {tab === 'closeout' && today && <CloseoutTab today={today} onReviewFlags={() => go('flags')} />}
          {tab === 'flags' && <FlagsTab />}
          {tab === 'menu' && <MenuTab />}
          {tab === 'staff' && <StaffTab />}
          {tab === 'devices' && <DevicesTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </div>
    </ManagerGate>
  );
}
