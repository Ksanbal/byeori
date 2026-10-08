import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import type { Actor, Architecture, Prd } from '../../src/contracts';
import { parseYaml } from '../../src/core/yaml';
import { createChange, currentBinding, deleteDraft, initializeWorkspace, putDraft } from '../../src/core/workspace';
import { prepareReview, roundBinding } from '../../src/core/review';
import { apply } from '../../src/core/apply';
import { startStudio } from '../../src/server';
import { browserSession } from '../server/helpers';

/** Genuine synthetic baseline through authenticated save/submit/apply; next round has four review items. */
export async function reviewFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori-review-ui-'));
  const read = (kind: string) => parseYaml(readFileSync(new URL('../fixtures/planning/' + kind + '.yaml', import.meta.url), 'utf8'));
  const prd = read('prd') as unknown as Prd; const actor = read('actor') as unknown as Actor; const architecture = read('architecture') as unknown as Architecture;
  architecture.relations = [];
  await initializeWorkspace(root, '합성 네 항목 리뷰'); const binding = await currentBinding(root);
  let baseline = await createChange(root, {...binding, metadata: {type: 'spec_change', title: '합성 기준 문서', request: '합성 회귀 검증의 기준 문서를 만든다.', reason: '실제 승인 체인 준비', affected_object_ids: [], implementation_scope: {allowlist: [], related_object_ids: [], validation_plan: []}}});
  for (const [name, content] of [['prd', prd], ['actor', actor], ['architecture', architecture]] as const) baseline = (await putDraft(root, {...binding, change_id: baseline.change_id, expected_version: baseline.version, object_id: content.id, kind: content.kind, path: 'planning/source/' + name + '.yaml', raw: stringify(content)})).change;
  const baselineRound = await prepareReview(root, {...binding, change_id: baseline.change_id, expected_version: baseline.version});
  const server = await startStudio(root, {assetsRoot: path.resolve('dist/studio')});
  const session = await browserSession(server.runtime.url!);
  const baselineFeedback = {...roundBinding(baselineRound), items: baselineRound.manifest.items.map(item => ({item_id: item.item_id, decision: 'approve' as const, comments: []})), implementation_authorization: {allowed: false as const, scope_hash: null}};
  const saved = (await session.post('/api/review/draft', {...baselineFeedback, expected_version: null})).result<{version: string}>();
  if (!saved.ok) throw new Error('Synthetic baseline save failed');
  const submitted = (await session.post('/api/review/submit', {...baselineFeedback, schema_version: 1, submission_id: crypto.randomUUID(), expected_feedback_version: saved.data.version, final_confirmation: true})).result();
  if (!submitted.ok) throw new Error('Synthetic baseline explicit submit failed');
  await apply(root, roundBinding(baselineRound));
  let change = await createChange(root, {...binding, metadata: {type: 'spec_change', title: '담당 범위와 기획 정리', request: '담당 범위를 바꾸고 이전 구조 문서를 삭제합니다.', reason: '합성 다중 리뷰 회귀 검증', affected_object_ids: ['PRD-DEMO-001', 'ACT-WORKER-001', 'ARCH-DEMO-001'], implementation_scope: {allowlist: [{path: 'src/service.ts', match: 'file'}], related_object_ids: ['PRD-DEMO-001'], validation_plan: ['합성 기능 테스트를 실행한다.']}}});
  prd.purpose = '검토 후 상담 요청을 담당 팀으로 전달한다.';
  actor.permissions = [{action: 'message.read', scope: 'assigned_team'}, {action: 'message.reply', scope: 'assigned_team'}];
  for (const [name, content] of [['prd', prd], ['actor', actor]] as const) change = (await putDraft(root, {...binding, change_id: change.change_id, expected_version: change.version, object_id: content.id, kind: content.kind, path: 'planning/source/' + name + '.yaml', raw: stringify(content)})).change;
  change = await deleteDraft(root, {...binding, change_id: change.change_id, expected_version: change.version, object_id: architecture.id});
  const round = await prepareReview(root, {...binding, change_id: change.change_id, expected_version: change.version});
  return {root, binding, change, round, url: server.runtime.url!, cleanup: async () => {await server.close(); await rm(root, {recursive: true, force: true});}};
}
