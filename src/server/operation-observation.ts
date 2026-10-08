import { realpath } from 'node:fs/promises';

type Observation = { phase: 'admitted' | 'completed'; route: string } | { phase: 'quiescing' };
const observers = new Map<string, (event: Observation) => Promise<void>>();
/** Internal lifecycle observations only; no credentials, Core capability or result can be supplied. */
export async function observeStudioOperations(root: string, observer: (event: Observation) => Promise<void>): Promise<() => void> {
  const canonical = await realpath(root);
  if (observers.has(canonical)) throw new Error('An operation observer already exists.');
  observers.set(canonical, observer); return () => { observers.delete(canonical); };
}
export async function operationObserved(root: string, event: Observation): Promise<void> { await observers.get(root)?.(event); }
