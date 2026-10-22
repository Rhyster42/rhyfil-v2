import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { db } from './db/db';
import { setClockOffset } from './sync/clock';
import './styles.css';

// Ask the browser not to evict our data under storage pressure: unsynced
// orders live only here (docs/decisions/0001).
void navigator.storage?.persist?.();

void db.getMeta('clockOffsetMs').then((offset) => {
  setClockOffset(offset ?? 0);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
