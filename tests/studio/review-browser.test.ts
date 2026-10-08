import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect, type Page, type Browser } from '@playwright/test';
import { reviewResults, prepareReview, roundBinding } from '../../src/core/review';
import { apply } from '../../src/core/apply';
import { CoreError } from '../../src/core/errors';
import { gateCheck } from '../../src/core/state';
import { putDraft } from '../../src/core/workspace';
import { parseYaml } from '../../src/core/yaml';
import { stringify } from 'yaml';
import type { Prd } from '../../src/contracts';
import { reviewFixture } from './review-setup';
import { studioFixture } from './setup';

function barrier() {let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;}); return {wait, release};}

const screenshots = path.resolve('artifacts/test-screenshots/review');
async function openReview(page: Page, url: string) {
  await page.goto(url); await page.getByRole('tab', {name: '리뷰', exact: true}).click();
  await expect(page.getByRole('button', {name: '리뷰 제출', exact: true})).toBeEnabled();
}
async function item(page: Page, id: string) {
  await page.getByRole('navigation', {name: '문서 목록'}).getByRole('button', {name: new RegExp(id)}).click();
  await expect(page.getByRole('combobox', {name: '이 항목의 판단'})).toBeVisible();
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole('combobox', {name: label, exact: true}).click(); await page.getByRole('option', {name: option, exact: true}).click();
}
async function saved(page: Page) {await expect(page.getByRole('status', {name: '리뷰 저장 상태'})).toContainText('서버에 저장됨');}
async function allApprove(page: Page) {
  for (const id of ['ACT-WORKER-001','ARCH-DEMO-001','PRD-DEMO-001','scope:implementation']) {await item(page, id); await select(page, '이 항목의 판단', '승인'); await saved(page);}
}
async function advisory(page: Page) {
  await page.getByRole('button', {name: '호스트 보호 상태', exact: true}).click();
  await expect(page.getByText('현재 강제 보호가 확인되지 않음').first()).toBeVisible();
  await page.getByLabel('권고 모드 선택 이유', {exact: true}).fill('합성 테스트에서 강제 보호 부재를 명시적으로 수용');
  await page.getByRole('checkbox', {name: '강제 보호가 없다는 한계를 이해하고 권고 모드를 선택합니다', exact: true}).check();
  await page.getByRole('button', {name: '권고 모드 선택', exact: true}).click();
  await expect(page.getByText('사람이 권고 모드를 선택함:', {exact: false})).toBeVisible();
  await page.getByRole('button', {name: '호스트 보호 상태', exact: true}).click();
}

test('real four-item mixed judgment autosaves targeted comments and finalizes without planning/implementation approval', {timeout: 90_000}, async () => {
  const fixture = await reviewFixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    await mkdir(screenshots, {recursive: true}); const context = await browser.newContext({viewport: {width: 1440, height: 900}}); const page = await context.newPage();
    await openReview(page, fixture.url);
    await expect(page.getByRole('status', {name: '리뷰 저장 상태'})).toContainText('미검토 4개');
    await item(page, 'ACT-WORKER-001'); await select(page, '이 항목의 판단', '승인'); await saved(page);
    await item(page, 'PRD-DEMO-001'); await select(page, '이 항목의 판단', '수정 요청'); await saved(page);
    await page.getByRole('button', {name: '댓글과 대상 (0)', exact: true}).click();
    await page.getByLabel('새 댓글', {exact: true}).fill('목적의 담당 범위를 다시 설명해 주세요.');
    await select(page, '분류', '수정 요청'); await select(page, '안정된 대상', 'goals · GOAL-001'); await select(page, '대상의 필드', 'text');
    await page.getByLabel('세부 JSON Pointer (선택)', {exact: true}).fill('/goals/0/text');
    await page.getByRole('checkbox', {name: '해결 전 승인 차단', exact: true}).check(); await page.getByRole('button', {name: '댓글 추가', exact: true}).click(); await saved(page);
    await item(page, 'scope:implementation'); await select(page, '이 항목의 판단', '승인'); await saved(page);
    await item(page, 'ARCH-DEMO-001'); await expect(page.getByText('삭제', {exact: true})).toBeVisible();
    await item(page, 'PRD-DEMO-001'); await expect(page.getByRole('combobox', {name: '이 항목의 판단'})).toContainText('수정 요청');
    const draft = await reviewResults(fixture.root, roundBinding(fixture.round)); assert.equal(draft.accepted_submission, null); assert.equal(draft.approval.documents_approved, false);
    const comment = draft.draft!.items.find(item => item.item_id === 'document:PRD-DEMO-001')!.comments[0];
    assert.equal(comment.kind, 'change_request'); assert.equal(comment.blocking, true); assert.equal(comment.target.element_id, 'GOAL-001'); assert.equal(comment.target.field, 'text'); assert.equal(comment.target.pointer, '/goals/0/text');
    await page.getByRole('button', {name: '리뷰 제출', exact: true}).press('Enter'); const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('합성 다중 리뷰 회귀 검증'); await expect(dialog).toContainText('ARCH-DEMO-001'); await expect(dialog).toContainText('assigned_only'); await expect(dialog).toContainText('assigned_team'); await expect(dialog).toContainText('src/service.ts'); await expect(dialog).toContainText(fixture.round.manifest.scope_hash);
    await expect(dialog.getByRole('checkbox', {name: '기획 승인 후 위 범위의 구현도 허용'})).toBeDisabled();
    await page.screenshot({path: path.join(screenshots, 'mixed-confirmation.png')});
    await dialog.getByRole('button', {name: '이 판단으로 최종 제출', exact: true}).click(); await expect(page.getByText('최종 판단이 기록되었습니다', {exact: true})).toBeVisible();
    const result = await reviewResults(fixture.root, roundBinding(fixture.round)); assert.equal(result.accepted_submission?.provenance, 'studio_human_submit'); assert.equal(result.approval.documents_approved, false); assert.equal(result.approval.implementation_allowed, false); assert.equal(result.accepted_submission?.submission.items.filter(item => item.decision === 'pending').length, 1);
    await expect(page.getByRole('combobox', {name: '이 항목의 판단'})).toBeDisabled(); await expect(page.getByText('대화에서 에이전트에게 ‘리뷰 완료’라고 알려 주세요.', {exact: true})).toBeVisible();
    await page.reload(); await page.getByRole('tab', {name: '리뷰', exact: true}).click(); await expect(page.getByText('최종 판단이 기록되었습니다', {exact: true})).toBeVisible();
    await context.close();
  } finally {try {await browser?.close();} finally {await fixture.cleanup();}}
});

test('real planning-only vs exact-scope permission, response loss, reload and deleted snapshot history remain distinct', {timeout: 120_000}, async () => {
  for (const permission of [false, true]) {
    const fixture = await reviewFixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
      const context = await browser.newContext({viewport: {width: 1440, height: 900}}); const page = await context.newPage(); await openReview(page, fixture.url); await allApprove(page); await advisory(page);
      let submits = 0;
      await page.route('**/api/review/submit', async route => {submits++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');});
      await page.getByRole('button', {name: '리뷰 제출', exact: true}).click();
      if (permission) await page.getByRole('dialog').getByRole('checkbox', {name: '기획 승인 후 위 범위의 구현도 허용'}).check();
      else await expect(page.getByRole('dialog')).toContainText('기본값: 기획 판단만 제출');
      await page.getByRole('dialog').getByRole('button', {name: '이 판단으로 최종 제출', exact: true}).dblclick();
      await expect(page.getByText('최종 판단이 기록되었습니다', {exact: true})).toBeVisible(); assert.equal(submits, 1);
      const result = await reviewResults(fixture.root, roundBinding(fixture.round)); assert.equal(result.approval.documents_approved, true); assert.equal(result.approval.implementation_allowed, permission); assert.equal(result.accepted_submission!.submission.implementation_authorization.allowed, permission);
      assert.equal(result.accepted_submission!.submission.expected_feedback_version, result.draft!.version);
      await apply(fixture.root, roundBinding(fixture.round));
      const gate = {...fixture.binding, host: 'codex' as const, tool: 'edit', operation: 'implementation_write' as const, paths: ['src/service.ts']};
      if (permission) {assert.equal((await gateCheck(fixture.root, gate)).allowed, true); await assert.rejects(() => gateCheck(fixture.root, {...gate, paths: ['src/other.ts']}), error => error instanceof CoreError && error.diagnostics[0].code === 'SCOPE_DENIED');}
      else await assert.rejects(() => gateCheck(fixture.root, gate), error => error instanceof CoreError && error.diagnostics[0].code === 'REVIEW_REQUIRED');
      await page.getByRole('button', {name: '최신 상태 확인', exact: true}).click(); await expect(page.getByText('원본 반영', {exact: true}).last()).toBeVisible();
      await item(page, 'ARCH-DEMO-001'); await page.getByRole('main').getByRole('button', {name: '이력', exact: true}).click(); await expect(page.getByRole('dialog')).toContainText('원본 반영'); await page.getByRole('dialog').getByRole('button', {name: '1차 변경 전', exact: true}).click();
      await expect(page.locator('article:visible')).toContainText('ARCH-DEMO-001'); await expect(page.getByText('과거 고정본', {exact: true})).toBeVisible();
      await assert.rejects(() => readFile(path.join(fixture.root, 'planning/source/architecture.yaml')), {code: 'ENOENT'});
      const fresh = await browser.newContext(); const freshPage = await fresh.newPage(); await freshPage.goto(fixture.url); await expect(freshPage.getByRole('tab')).toHaveCount(2); await fresh.close(); await context.close();
    } finally {try {await browser?.close();} finally {await fixture.cleanup();}}
  }
});

test('two real tabs preserve conflict/stale input, and an explicit new round starts pending with an archived copy', {timeout: 90_000}, async () => {
  const fixture = await reviewFixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const context = await browser.newContext(); const a = await context.newPage(); const b = await context.newPage(); await openReview(a, fixture.url); await openReview(b, fixture.url);
    await item(a, 'PRD-DEMO-001'); await select(a, '이 항목의 판단', '승인'); await saved(a);
    await item(b, 'PRD-DEMO-001'); await select(b, '이 항목의 판단', '수정 요청'); await expect(b.getByText('다른 작업과 충돌했습니다.', {exact: false})).toBeVisible(); await expect(b.getByRole('combobox', {name: '이 항목의 판단'})).toContainText('수정 요청');
    await b.getByRole('button', {name: '입력 사본 보존 후 저장본 불러오기', exact: true}).click(); await expect(b.getByLabel('보존한 입력 사본 · 복사 가능')).toHaveValue(/request_changes/); await expect(b.getByRole('combobox', {name: '이 항목의 판단'})).toContainText('승인');
    const raw = await readFile(path.join(fixture.root, fixture.round.manifest.deltas.find(delta => delta.object_id === 'PRD-DEMO-001')!.after!.snapshot_path), 'utf8');
    const draft = parseYaml(raw) as unknown as Prd; draft.purpose = '아직 검토하지 않은 새 초안 목적';
    const changed = (await putDraft(fixture.root, {...fixture.binding, change_id: fixture.change.change_id, expected_version: fixture.change.version, object_id: draft.id, kind: draft.kind, path: 'planning/source/prd.yaml', raw: stringify(draft)})).change;
    await select(a, '이 항목의 판단', '수정 요청'); await expect(a.getByText('검토본이 오래되었습니다.', {exact: false})).toBeVisible(); await expect(a.getByRole('combobox', {name: '이 항목의 판단'})).toContainText('수정 요청');
    await expect(a.locator('article:visible').last()).toContainText('검토 후 상담 요청을 담당 팀으로 전달한다.'); await expect(a.locator('article:visible').last()).not.toContainText(draft.purpose);
    const next = await prepareReview(fixture.root, {...fixture.binding, change_id: fixture.change.change_id, expected_version: changed.version}); assert.equal(next.manifest.round, 2);
    await a.getByRole('button', {name: '최신 상태 확인', exact: true}).click(); await expect(a.getByRole('button', {name: '입력 사본 보존 후 새 리뷰 열기', exact: true})).toBeVisible();
    await a.getByRole('button', {name: '입력 사본 보존 후 새 리뷰 열기', exact: true}).click(); await expect(a.getByRole('status', {name: '리뷰 저장 상태'})).toContainText('미검토 4개'); await expect(a.getByLabel('보존한 입력 사본 · 복사 가능')).toHaveValue(/request_changes/); await expect(a.getByRole('combobox', {name: '이 항목의 판단'})).toContainText('미검토');
    await a.screenshot({path: path.join(screenshots, 'stale-preserved-copy.png')});
    await context.close();
  } finally {try {await browser?.close();} finally {await fixture.cleanup();}}
});

test('latest typing survives a delayed genuine save; invalid body and network failure retain input with explicit retry', {timeout: 90_000}, async () => {
  const fixture = await reviewFixture(); let browser: Browser | undefined;
  const held = barrier(); const release = barrier();
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const context = await browser.newContext(); const page = await context.newPage(); await openReview(page, fixture.url); await item(page, 'PRD-DEMO-001');
    await page.getByRole('button', {name: '댓글과 대상 (0)', exact: true}).click(); await page.getByLabel('새 댓글', {exact: true}).fill('먼저 입력한 합성 댓글'); await page.getByRole('button', {name: '댓글 추가', exact: true}).click(); await saved(page);
    let once = true;
    await page.route('**/api/review/draft', async route => {
      if (!once) {await route.continue(); return;} once = false;
      const response = await route.fetch(); assert.equal(response.status(), 200); held.release(); await release.wait; await route.fulfill({response});
    });
    await page.getByLabel('저장할 댓글 1', {exact: true}).fill('저장 요청에 들어간 첫 내용'); await held.wait;
    await page.getByLabel('저장할 댓글 1', {exact: true}).fill('진행 중에 더 최근에 입력한 내용'); release.release(); await saved(page);
    await expect(page.getByLabel('저장할 댓글 1', {exact: true})).toHaveValue('진행 중에 더 최근에 입력한 내용');
    assert.equal((await reviewResults(fixture.root, roundBinding(fixture.round))).draft!.items.find(item => item.item_id === 'document:PRD-DEMO-001')!.comments[0].body, '진행 중에 더 최근에 입력한 내용');
    await page.unroute('**/api/review/draft');
    await page.getByLabel('저장할 댓글 1', {exact: true}).fill(''); await expect(page.getByText('문서나 요청이 유효하지 않습니다.', {exact: false})).toBeVisible();
    await expect(page.getByLabel('저장할 댓글 1', {exact: true})).toHaveValue('');
    await page.getByLabel('저장할 댓글 1', {exact: true}).fill('유효성 오류 뒤에 보존한 수정'); await page.getByRole('button', {name: '저장 다시 시도', exact: true}).click(); await saved(page);
    await page.route('**/api/review/draft', route => route.abort('failed'));
    await page.getByLabel('저장할 댓글 1', {exact: true}).fill('연결 실패 중 보존해야 할 최신 입력'); await expect(page.getByRole('status', {name: '리뷰 저장 상태'})).toContainText('실패'); await expect(page.getByLabel('저장할 댓글 1', {exact: true})).toHaveValue('연결 실패 중 보존해야 할 최신 입력');
    await page.screenshot({path: path.join(screenshots, 'failed-save-input.png')});
    await page.unroute('**/api/review/draft'); await page.getByRole('button', {name: '저장 다시 시도', exact: true}).click(); await saved(page);
    assert.equal((await reviewResults(fixture.root, roundBinding(fixture.round))).draft!.items.find(item => item.item_id === 'document:PRD-DEMO-001')!.comments[0].body, '연결 실패 중 보존해야 할 최신 입력');
    await page.getByLabel('새 댓글', {exact: true}).fill('추가 전 댓글도 항목 이동에서 유지'); await item(page, 'ACT-WORKER-001'); await item(page, 'PRD-DEMO-001'); await page.getByRole('button', {name: '댓글과 대상 (1)', exact: true}).click(); await expect(page.getByLabel('새 댓글', {exact: true})).toHaveValue('추가 전 댓글도 항목 이동에서 유지'); await expect(page.getByRole('button', {name: '리뷰 제출', exact: true})).toBeDisabled();
    await context.close();
  } finally {release.release(); try {await browser?.close();} finally {await fixture.cleanup();}}
});

test('unacknowledged submit stays frozen until real readback, then retries the identical ID; fresh session sees final result', {timeout: 90_000}, async () => {
  const fixture = await reviewFixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const context = await browser.newContext(); const page = await context.newPage(); await openReview(page, fixture.url); await allApprove(page);
    let first = true; const ids: string[] = []; let failedReadback = false;
    await page.route('**/api/review/submit', async route => {ids.push((route.request().postDataJSON() as {submission_id: string}).submission_id); if (first) {first = false; failedReadback = true; await route.abort('failed');} else await route.continue();});
    await page.route('**/api/review/results', async route => {if (failedReadback) await route.abort('failed'); else await route.continue();});
    await page.getByRole('button', {name: '리뷰 제출', exact: true}).click(); await page.getByRole('dialog').getByRole('button', {name: '이 판단으로 최종 제출', exact: true}).click();
    await expect(page.getByRole('status', {name: '리뷰 저장 상태'})).toContainText('제출 결과 확인 필요'); await expect(page.getByRole('combobox', {name: '이 항목의 판단'})).toBeDisabled();
    await page.screenshot({path: path.join(screenshots, 'uncertain-submit.png')});
    failedReadback = false; await page.getByRole('button', {name: '같은 제출 다시 시도', exact: true}).click(); await expect(page.getByText('최종 판단이 기록되었습니다', {exact: true})).toBeVisible(); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
    const final = await reviewResults(fixture.root, roundBinding(fixture.round)); assert.equal(final.accepted_submission?.submission.submission_id, ids[0]);
    const next = await browser.newContext(); const reloaded = await next.newPage(); await reloaded.goto(fixture.url); await reloaded.getByRole('tab', {name: '리뷰', exact: true}).click(); await expect(reloaded.getByText('최종 판단이 기록되었습니다', {exact: true})).toBeVisible(); await expect(reloaded.getByRole('combobox', {name: '이 항목의 판단'})).toBeDisabled(); await expect(reloaded.getByRole('button', {name: '리뷰 제출', exact: true})).toHaveCount(0); await next.close(); await context.close();
  } finally {try {await browser?.close();} finally {await fixture.cleanup();}}
});

test('real native field and OpenAPI operation comments, keyboard dialog and responsive reduced-motion content', {timeout: 120_000}, async () => {
  const fixture = await studioFixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'}); const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); await openReview(page, fixture.url);
    await item(page, 'SCN-MSG-001'); await page.getByRole('button', {name: '댓글과 대상 (0)', exact: true}).click(); await page.getByLabel('새 댓글', {exact: true}).fill('단계 행동 확인 질문'); await select(page, '안정된 대상', 'steps · STEP-SEND'); await select(page, '대상의 필드', 'action'); await page.getByRole('button', {name: '댓글 추가', exact: true}).click(); await saved(page);
    await item(page, 'API-MSG-001'); await page.getByRole('button', {name: '댓글과 대상 (0)', exact: true}).click(); await page.getByLabel('새 댓글', {exact: true}).fill('작업 요청 본문 참고'); await select(page, '분류', '참고'); await select(page, '안정된 대상', 'POST /messages · sendMessage'); await select(page, '대상의 필드', 'requestBody'); await page.getByLabel('세부 JSON Pointer (선택)').fill('/paths/~1messages/post/requestBody/content/application~1json/schema/properties/body'); await page.getByRole('button', {name: '댓글 추가', exact: true}).click(); await saved(page);
    const result = await reviewResults(fixture.root, roundBinding(fixture.round)); const native = result.draft!.items.find(item => item.item_id === 'document:SCN-MSG-001')!.comments[0]; const api = result.draft!.items.find(item => item.item_id === 'document:API-MSG-001')!.comments[0]; assert.equal(native.kind, 'question'); assert.equal(native.target.element_id, 'STEP-SEND'); assert.equal(api.kind, 'note'); assert.equal(api.target.operation_id, 'sendMessage'); assert.equal(api.target.field, 'requestBody');
    await mkdir(screenshots, {recursive: true});
    for (const [width, height] of [[1440,900],[1024,768],[390,844]]) {
      await page.setViewportSize({width,height}); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path: path.join(screenshots, `review-${width}x${height}.png`)}); assert.ok(await page.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth));
      await page.getByRole('button', {name: '리뷰 제출', exact: true}).press('Enter'); await expect(page.getByRole('dialog', {name: '최종 리뷰 확인'})).toBeVisible(); await expect(page.getByRole('dialog')).toContainText('기본값: 기획 판단만 제출'); await page.screenshot({path: path.join(screenshots, `confirm-${width}x${height}.png`)}); await page.getByRole('dialog').press('Escape'); await expect(page.getByRole('button', {name: '리뷰 제출', exact: true})).toBeFocused();
    }
    await page.getByRole('button', {name: '문서 목록 열기', exact: true}).press('Enter'); await page.getByRole('dialog').getByRole('button', {name: /SCN-MSG-001/}).click(); await page.getByRole('button', {name: '목록 닫기', exact: true}).click(); await expect(page.locator('article:visible')).toContainText('STEP-SEND');
    assert.deepEqual(errors, []); console.log('B07 normal isolated Chrome', browser.version(), '1440x900/1024x768/390x844 reduced motion; real targets/focus/no page errors'); await context.close();
  } finally {try {await browser?.close();} finally {await fixture.cleanup();}}
});
