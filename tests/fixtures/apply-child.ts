import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apply, recover } from '../../src/core/apply';
import type { ReviewBinding } from '../../src/contracts';

const [root, encoded, desired, occurrenceText = '1', action = 'apply'] = process.argv.slice(2);
const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ReviewBinding;
let occurrence = 0;
try {
  const dependencies = {
    async afterBoundary(boundary: string) {
      if (boundary !== desired || ++occurrence !== Number(occurrenceText)) return;
      process.send?.({ boundary });
      await new Promise<void>(resolve => process.once('message', () => resolve()));
    },
    async refreshCache() { await mkdir(path.join(root, '.byeori'), { recursive: true }); await writeFile(path.join(root, '.byeori/test-refresh'), 'disposable test cache observation'); },
  };
  if (action === 'recover') await recover(root, { project_id: binding.project_id, workspace_fingerprint: binding.workspace_fingerprint, change_id: binding.change_id, action: 'resume' }, dependencies);
  else await apply(root, binding, dependencies);
  process.disconnect?.();
} catch (error) { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.(); }
