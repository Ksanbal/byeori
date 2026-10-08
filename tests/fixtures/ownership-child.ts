import { withWriteLock } from '../../src/core/ownership';

const root = process.argv[2];
await withWriteLock(root, 'real child ownership test', async writer => {
  await writer.write('planning/test-progress.txt', 'before');
  const continueSignal = new Promise<void>(resolve => process.once('message', () => resolve()));
  process.send?.('ready');
  await continueSignal;
  await writer.write('planning/test-progress.txt', 'after');
});
process.disconnect?.();
