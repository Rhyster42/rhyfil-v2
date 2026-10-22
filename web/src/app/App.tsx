import { useEffect } from 'react';
import { SignInScreen } from '../auth/SignInScreen';
import { useMeta } from '../db/db';
import { SetupScreen } from '../setup/SetupScreen';
import { engine } from './services';
import { Shell } from './Shell';

/** Enrolled? Signed in? Then the register. */
export function App() {
  const device = useMeta('device');
  const session = useMeta('session');
  const deviceId = device?.id;

  useEffect(() => {
    if (!deviceId) return;
    engine.start();
    return () => engine.stop();
  }, [deviceId]);

  if (device === undefined || session === undefined) return null;
  if (device === null) return <SetupScreen />;
  if (session === null) return <SignInScreen />;
  return <Shell staffId={session.staffId} />;
}
