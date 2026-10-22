// App-wide singletons.
import { db } from '../db/db';
import { SyncEngine } from '../sync/engine';

export const engine = new SyncEngine(db);
