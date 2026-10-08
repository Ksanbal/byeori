import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { initializeWorkspace, currentBinding, createChange, putDraft } from '../../src/core/workspace';
import { prepareReview } from '../../src/core/review';
import { parseDocument } from '../../src/core/documents';
import { parseYaml } from '../../src/core/yaml';
import { startStudio } from '../../src/server';

export async function studioFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori-ui-'));
  await initializeWorkspace(root, '합성 상담 프로젝트');
  const binding = await currentBinding(root);
  let change = await createChange(root, { ...binding, metadata: {type: 'spec_change', title: '상담 기획 검토', request: '9종 합성 문서를 검토해 주세요.', reason: '브라우저 읽기 검증', affected_object_ids: [], implementation_scope: {allowlist: [], related_object_ids: [], validation_plan: []}}});
  const directory = new URL('../fixtures/planning/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.yaml'))) {
    let raw = readFileSync(new URL(name, directory), 'utf8');
    if (name === 'openapi.yaml') {
      const content = parseYaml(raw) as Record<string, unknown>;
      content['x-browser-check'] = {nested: {text: '<script>window.untrustedExecuted=true</script>', link: 'https://example.invalid/external-ref', flag: false, nil: null, empty: []}};
      raw = stringify(content);
    }
    const document = parseDocument({path: 'planning/source/' + name, raw});
    change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw})).change;
  }
  const round = await prepareReview(root, {...binding, change_id: change.change_id, expected_version: change.version});
  const server = await startStudio(root, {assetsRoot: path.resolve('dist/studio')});
  if (!server.runtime.url) throw new Error('Studio did not start');
  return {root, binding, change, url: server.runtime.url, round, cleanup: async () => {await server.close(); await rm(root, {recursive: true, force: true});}};
}
