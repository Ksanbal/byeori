import { RUNTIME_VERSION } from '../version';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { DoctorResult, ValidationRequest, ValidationResult } from '../contracts';
import { readTransaction } from './apply';
import { validateSource, sourceManifest, type ParsedDocument } from './documents';
import { CoreError, reject } from './errors';
import { withWriteLock } from './ownership';
import { readText, recordId, safePath } from './paths';
import { recordFiles } from './record-io';
import { readRound, roundDocuments, roundNumbers, sourceHead } from './review';
import { readHost, status } from './state';
import { loadProjectedChange, loadRawSource, readProjectConfig, workspaceIdentity } from './workspace';
import { semanticHash, VERSIONS } from './yaml';

export async function lint(inputRoot: string, input: ValidationRequest = {}): Promise<ValidationResult> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root; const scope = input.scope ?? { type: 'approved' }; const stage = input.stage ?? 'structural';
  if (!['structural', 'review_ready', 'implementation_ready'].includes(stage) || !['approved', 'change', 'history'].includes(scope.type)) reject('VALIDATION_FAILED', 'Unknown validation scope/stage.');
  return withWriteLock(root, 'lint', async () => {
    const config = await readProjectConfig(root); const head = await sourceHead(root);
    if (head.applied && (await readTransaction(root, head.applied.change_id)).transaction.phase !== 'completed') reject('APPLY_RECOVERY_REQUIRED', 'Validation requires completed apply.');
    const groups: ParsedDocument[][] = [];
    if (scope.type === 'approved') groups.push(validateSource(await loadRawSource(root)));
    else if (scope.type === 'change') { recordId(scope.change_id); groups.push(await loadProjectedChange(root, scope.change_id)); }
    else {
      if (scope.change_id !== undefined) recordId(scope.change_id);
      if (scope.round !== undefined && (!scope.change_id || !Number.isSafeInteger(scope.round) || scope.round < 1)) reject('VALIDATION_FAILED', 'Historical round requires change ID and positive round.');
      for (const file of await recordFiles(root, 'change.yaml')) {
        const id = file.slice('planning/changes/'.length).split('/')[0]; if (scope.change_id && scope.change_id !== id) continue;
        for (const number of await roundNumbers(root, id)) { if (scope.round && scope.round !== number) continue; const round = await readRound(root, id, number); for (const side of ['before', 'after'] as const) groups.push(await roundDocuments(root, round, side)); }
      }
    }
    // Structural and review_ready share the current full reference/relationship profile.
    for (const documents of groups) validateSource(documents.map(({ path, raw }) => ({ path, raw })), stage === 'implementation_ready' ? stage : 'review_ready');
    return { valid: true, checked_object_ids: [...new Set(groups.flatMap(documents => documents.map(document => document.id)))], source_hash: semanticHash(groups.map(documents => sourceManifest(config.project_id, documents))) };
  });
}
export async function doctor(inputRoot: string): Promise<DoctorResult> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  const [major, minor, patch] = process.versions.node.split('.').map(Number); const compatible = major === 24 && (minor > 13 || minor === 13 && patch >= 0);
  let available = false; let fts5 = false; let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(':memory:', { allowExtension: false }); available = true; db.exec('CREATE VIRTUAL TABLE probe USING fts5(body);'); db.prepare('INSERT INTO probe VALUES (?)').run('byeori 상담'); fts5 = db.prepare('SELECT count(*) AS count FROM probe WHERE probe MATCH ?').get('"상담"')?.count === 1; } catch { /* Capability is reported explicitly below. */ } finally { db?.close(); }
  let writable = true;
  for (const relative of ['planning', 'planning/source', 'planning/.runtime']) {
    try { await access(await safePath(root, relative), constants.W_OK); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') writable = false; }
  }
  try { await access(root, constants.W_OK); } catch { writable = false; }
  let schemasCompatible = true; let continuity: DoctorResult['status'] = null;
  try { await readProjectConfig(root); if (writable) continuity = await status(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (!(error instanceof CoreError) || !error.diagnostics.every(diagnostic => ['POLICY_MISMATCH', 'VALIDATION_FAILED', 'WORKSPACE_MISMATCH'].includes(diagnostic.code))) throw error;
      schemasCompatible = false;
    }
  }
  const instructionPaths: string[] = [];
  for (const file of ['AGENTS.md', 'CLAUDE.md']) { try { await readText(root, file); instructionPaths.push(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return { node: { version: process.version, compatible }, sqlite: { available, fts5_probed: fts5, extension_loading: false }, schemas: { runtime_version: RUNTIME_VERSION, schema_version: VERSIONS.schema_version, compatible: schemasCompatible }, writable, instruction_paths: instructionPaths, hosts: [await readHost(root, 'claude'), await readHost(root, 'codex')], status: continuity };
}
