import { startStudio, type StudioServerOptions } from './server';
import { safeResult } from './protocol';

/** Dedicated Node child entrypoint; parent sends trusted local paths over IPC, never a secret URL. */
process.once('message', async (message: unknown) => {
  const response = await safeResult(async () => {
    if (!message || typeof message !== 'object' || !('root' in message) || typeof message.root !== 'string' || !('options' in message)) throw new Error('Invalid Studio worker launch.');
    return (await startStudio(message.root, message.options as StudioServerOptions)).runtime;
  });
  process.send?.(response, () => { process.disconnect?.(); });
  if (!response.ok) process.exitCode = 1;
});
