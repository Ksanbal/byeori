import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CoreError} from '../../src/core/errors';
import {readReceipt} from '../../src/core/review';
import {semanticHash} from '../../src/core/yaml';

test('receipt parser preserves legacy and terminal planning-only permission and rejects unknown provenance', async () => {
  // Isolated storage-parser data, not an initialized project or approval service.
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori receipt compatibility '));
  try {
    const directory = path.join(root, 'planning/reviews/submissions'); await mkdir(directory, {recursive:true});
    const body = {project_id:randomUUID(), workspace_fingerprint:'a'.repeat(64), change_id:randomUUID(), round:1, manifest_hash:'b'.repeat(64), items:[{item_id:'document:PRD-TEST-001', decision:'approve', comments:[]}], implementation_authorization:{allowed:false, scope_hash:null}};
    const submission = {...body, schema_version:1, submission_id:randomUUID(), expected_feedback_version:semanticHash(body), final_confirmation:true};
    const receipt = {submission, payload_hash:semanticHash(submission), submitted_at:new Date().toISOString(), provenance:'studio_human_submit'};
    const file = path.join(directory, submission.submission_id+'.yaml');
    for (const provenance of ['studio_human_submit','terminal_human_submit']) {
      await writeFile(file, JSON.stringify({...receipt, provenance}));
      const read = await readReceipt(root, submission.submission_id);
      assert.equal(read!.submission.implementation_authorization.allowed,false);
      assert.equal(read!.submission.implementation_authorization.scope_hash,null);
      assert.equal(read!.payload_hash,receipt.payload_hash);
    }
    await writeFile(file, JSON.stringify({...receipt, provenance:'agent_human_submit'}));
    await assert.rejects(readReceipt(root,submission.submission_id),error=>error instanceof CoreError&&error.diagnostics[0].code==='VALIDATION_FAILED');
  } finally {await rm(root,{recursive:true,force:true});}
});
