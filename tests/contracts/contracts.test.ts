import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CLI_COMMANDS, DOCUMENT_KINDS, DIAGNOSTIC_EXIT_CODES,
  type PlanningObject, type ReviewSubmission, type ContinuityStatus, type OpenApiDocument,
} from '../../src/contracts/index';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
const planning = ajv.compile<PlanningObject>(schema('planning-object'));
const review = ajv.compile<ReviewSubmission>(schema('review-submission'));
const base = { schema_version: 1 as const, id: 'DOC-ONE', title: 'Example', summary: 'Complete content', aliases: [], relations: [], open_questions: [] };
const documents: PlanningObject[] = [
  { ...base, kind: 'prd', purpose: 'Purpose', goals: [{ id: 'goal-1', text: 'Goal' }], in_scope: [], out_of_scope: [], constraints: [] },
  { ...base, kind: 'actor', responsibilities: ['Review'], permissions: [{ action: 'read', scope: 'own records' }] },
  { ...base, kind: 'scenario', actors: ['ACTOR-ONE'], preconditions: [], steps: [{ id: 'step-1', actor: 'ACTOR-ONE', action: 'Read', result: 'Visible' }], outcomes: [] },
  { ...base, kind: 'feature', actors: [], rules: [{ id: 'rule-1', text: 'Allow read' }], acceptance_criteria: [{ id: 'ac-1', given: 'A record', when: 'Read', then: 'Visible' }] },
  { ...base, kind: 'ia', nodes: [{ id: 'node-1', label: 'Records', screen_id: 'SCREEN-ONE', parent_id: null }] },
  { ...base, kind: 'screen', components: [{ id: 'component-1', type: 'table', label: 'Records', actions: ['read'] }], states: [{ id: 'state-1', description: 'Empty' }] },
  { ...base, kind: 'entity', fields: [{ id: 'field-1', name: 'id', type: 'string', nullable: false }], primary_key: ['field-1'], constraints: [] },
  { ...base, kind: 'architecture', components: [{ id: 'component-1', title: 'Core', responsibility: 'Read' }], connections: [], decisions: [] },
];
const hash = 'a'.repeat(64);
const submission: ReviewSubmission = {
  schema_version: 1, submission_id: 'submission-1', project_id: 'project-1', workspace_fingerprint: hash,
  change_id: 'change-1', round: 1, manifest_hash: hash, final_confirmation: true,
  implementation_authorization: { allowed: false, scope_hash: null },
  items: [
    { item_id: 'PRD-ONE', decision: 'approve', comments: [] },
    { item_id: 'FEATURE-ONE', decision: 'request_changes', comments: [{ id: 'comment-1', kind: 'change_request', body: 'Explain the rule', blocking: true, target: { object_id: 'FEATURE-ONE', element_id: 'rule-1', field: 'rules', operation_id: null, pointer: null } }] },
    { item_id: 'API-ONE', decision: 'pending', comments: [{ id: 'comment-2', kind: 'question', body: 'What response?', blocking: false, target: { object_id: 'API-ONE', element_id: null, field: null, operation_id: 'readRecord', pointer: '/paths/~1records/get/responses' } }] },
    { item_id: 'scope:implementation', decision: 'pending', comments: [] },
  ],
};

test('all eight typed native bodies are review-schema representable', () => {
  assert.equal(documents.length, 8);
  for (const document of documents) {
    assert.equal(planning(document), true, JSON.stringify(planning.errors));
    const incomplete = { ...document } as Record<string, unknown>;
    delete incomplete.title;
    assert.equal(planning(incomplete), false);
  }
});

test('mixed review and stable OpenAPI targets remain distinct from approval', () => {
  assert.equal(review(submission), true, JSON.stringify(review.errors));
  assert.equal(review({ ...submission, implementation_authorization: { allowed: true, scope_hash: hash } }), true);
  assert.equal(review({ ...submission, submission_id: '../escape' }), false);
  assert.equal(review({ ...submission, workspace_fingerprint: 'arbitrary' }), false);
  assert.equal(review({ ...submission, implementation_authorization: { allowed: true, scope_hash: null } }), false);
  assert.equal(review({ ...submission, implementation_authorization: { allowed: false, scope_hash: hash } }), false);
  // Valid input shape is intentionally not evidence that pending/request_changes is approved.
  assert.equal(submission.items.some(item => item.decision !== 'approve'), true);
});

test('OpenAPI stays a full standard document, not a native wrapper', () => {
  const document: OpenApiDocument = {
    openapi: '3.1.1', info: { title: 'Records', version: '1.0', 'x-byeori-id': 'API-ONE' },
    paths: { '/records': { get: { operationId: 'readRecord', 'x-byeori-features': ['FEATURE-ONE'], responses: { '200': { description: 'Records', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } } } } },
    components: { schemas: { Record: { type: 'object', properties: { id: { type: 'string' } } } } },
  };
  assert.equal(document.openapi, '3.1.1');
  assert.equal('kind' in document, false);
  assert.equal(planning(document), false);
});

test('continuity and CLI represent required wire fields without an agent approval command', () => {
  const status: ContinuityStatus = {
    project_id: 'project-1', workspace_fingerprint: hash,
    source_integrity: { state: 'valid', manifest_hash: hash, applied_change_id: null },
    workflow: { schema_version: 1, project_id: 'project-1', version: hash, updated_at: '2026-10-08T00:00:00.000Z', focus: { kind: null, object_id: null, change_id: null }, facts: [], assumptions: [], open_questions: [], next_action: null, feedback_progress: [], correction_attempts: [] },
    active_change: null, current_round: null, manifest_hash: null, pending_submissions: [], processed_comment_ids: [],
    apply_state: { state: 'idle' }, implementation_authorization: { state: 'none', change_id: null, manifest_hash: null, scope_hash: null, scope: null }, implementation_status: 'unverified',
  };
  for (const field of ['project_id', 'workspace_fingerprint', 'source_integrity', 'workflow', 'active_change', 'current_round', 'manifest_hash', 'pending_submissions', 'processed_comment_ids', 'apply_state', 'implementation_authorization']) assert.ok(field in status);
  assert.ok('focus' in status.workflow && 'next_action' in status.workflow && 'open_questions' in status.workflow);
  assert.equal(DOCUMENT_KINDS.length, 9);
  assert.equal(CLI_COMMANDS.length, 19);
  assert.equal(CLI_COMMANDS.some(command => command.includes('approve')), false);
  assert.equal(DIAGNOSTIC_EXIT_CODES.APPLY_RECOVERY_REQUIRED, 5);
});
