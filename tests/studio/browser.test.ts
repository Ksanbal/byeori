import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {chromium, expect} from '@playwright/test';
import {studioFixture} from './setup';
import {parseYaml, rawHash} from '../../src/core/yaml';
import type {JsonValue} from '../../src/contracts';

function leaves(value: JsonValue): string[] {
 if (value === null) return [];
 if (Array.isArray(value)) return value.flatMap(leaves);
 if (typeof value === 'object') return Object.values(value).flatMap(leaves);
 return typeof value === 'string' ? [value] : [];
}
test('real Chrome9 views, frozen history, responsive keyboard navigation and escaped OpenAPI content', {timeout:120000}, async () => {
 const fixture=await studioFixture(); const browser=await chromium.launch({channel:'chrome',headless:true});
 const screenshots=path.resolve('.delivery/agents/B06-ui-screenshots');await mkdir(screenshots,{recursive:true});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();const errors:string[]=[];const remote:string[]=[];
  page.on('pageerror',error=>errors.push(error.message)); page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{if(!request.url().startsWith(fixture.url)&&!request.url().startsWith('data:'))remote.push(request.url());});
  await page.goto(fixture.url);assert.equal(await page.title(),'Byeori');await expect(page.getByText('합성 상담 프로젝트',{exact:false})).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);await page.getByRole('tab',{name:'리뷰',exact:true}).click();
  const navigation=page.getByRole('navigation',{name:'문서 목록'});
  await navigation.getByRole('button',{name:'ACT-WORKER-001',exact:true}).dblclick();
  await navigation.getByRole('button',{name:'PRD-DEMO-001',exact:true}).click();
  await navigation.getByRole('button',{name:'SCN-MSG-001',exact:true}).click();
  await expect(page.locator('article')).toContainText('STEP-SEND');
  const cases=[['actor','ACT-WORKER-001'],['architecture','ARCH-DEMO-001'],['entity','ENT-MSG-001'],['feature','FEAT-MSG-001'],['ia','IA-DEMO-001'],['openapi','API-MSG-001'],['prd','PRD-DEMO-001'],['scenario','SCN-MSG-001'],['screen','SCR-MSG-001']] as const;
  for(const [kind,id] of cases){
   await page.getByRole('navigation',{name:'문서 목록'}).getByRole('button',{name:id,exact:true}).click();await expect(page.locator('article')).toContainText(id);
   const raw=await readFile(new URL(`../fixtures/planning/${kind}.yaml`,import.meta.url),'utf8'); const text=await page.locator('article').innerText();
   for(const value of leaves(parseYaml(raw)))assert.ok(text.includes(value),`Browser content missing ${kind}: ${value}`);
   await page.locator('article').screenshot({path:path.join(screenshots,`${kind}-structured.png`)});
  }
  await page.getByRole('navigation',{name:'문서 목록'}).getByRole('button',{name:'API-MSG-001',exact:true}).click(); await expect(page.locator('article')).toContainText('<script>window.untrustedExecuted=true</script>');
  assert.equal(await page.locator('article script').count(),0);assert.deepEqual(remote,[]);
  await page.getByRole('button',{name:'이력',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('review');
  await page.getByRole('button',{name:'1차 변경 후'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('article')).toContainText('API-MSG-001');
  await page.getByRole('button',{name:'자세히',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('semantic_hash');await page.getByRole('dialog').press('Escape');await expect(page.getByRole('button',{name:'자세히',exact:true})).toBeFocused();
  for(const [width,height] of [[1440,900],[1024,768],[390,844]]){
   await page.setViewportSize({width,height});await page.screenshot({path:path.join(screenshots,`viewport-${width}x${height}.png`)});
   assert.ok(await page.locator('body').evaluate(element=>element.scrollWidth<=window.innerWidth),`horizontal page overflow at ${width}`);
  }
  await page.getByRole('button',{name:'문서 목록 열기'}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'SCN-MSG-001',exact:true}).click();await page.getByRole('button',{name:'목록 닫기'}).click();await expect(page.locator('article')).toContainText('STEP-SEND');
  await page.getByRole('button',{name:'이력',exact:true}).press('Enter');await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('dialog').press('Escape');await expect(page.getByRole('button',{name:'이력',exact:true})).toBeFocused();
  await page.screenshot({path:path.join(screenshots,'mobile-scenario.png')});
  await expect(page.getByRole('button',{name:'확대',exact:true})).toBeVisible();await page.getByRole('button',{name:'확대',exact:true}).click();await expect(page.getByText('125%',{exact:true})).toBeVisible();await page.getByRole('button',{name:'초기화',exact:true}).click();await expect(page.getByText('100%',{exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);console.log('Chrome',browser.version(),'viewports1440x900,1024x768,390x844;9 documents all source strings retained; no console/page errors/remote refs.');
  await context.close();
 } finally {await browser.close();await fixture.cleanup();}
});
test('invalid real draft is preserved and displays a truthful retryable error, while frozen content stays readable', {timeout:30000}, async () => {
 const fixture=await studioFixture();const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const context=await browser.newContext();const page=await context.newPage();await page.goto(fixture.url);
  await page.getByRole('tab',{name:'리뷰',exact:true}).click();await page.getByRole('navigation',{name:'문서 목록'}).getByRole('button',{name:'SCN-MSG-001',exact:true}).click();await expect(page.locator('article')).toContainText('STEP-SEND');
  const {putDraft}=await import('../../src/core/workspace');const broken='broken: true\n';
  await putDraft(fixture.root,{...fixture.binding,change_id:fixture.change.change_id,expected_version:fixture.change.version,object_id:'SCN-MSG-001',kind:'scenario',path:'planning/source/scenario.yaml',raw:broken});
  await page.getByRole('tab',{name:'문서',exact:true}).click();await page.getByRole('button',{name:'변경 초안',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('문서나 요청이 유효하지 않습니다');await expect(page.locator('article')).toHaveCount(0);
  await page.getByRole('button',{name:'다시 시도',exact:true}).click();await expect(page.getByRole('alert')).toContainText('문서나 요청이 유효하지 않습니다');
  await page.screenshot({path:path.resolve('.delivery/agents/B06-ui-screenshots/invalid-draft.png')});
  await page.getByRole('tab',{name:'리뷰',exact:true}).click();await page.getByRole('navigation',{name:'문서 목록'}).getByRole('button',{name:'SCN-MSG-001',exact:true}).click();await expect(page.locator('article')).toContainText('STEP-SEND');
  assert.equal(await readFile(path.join(fixture.root,'planning/changes',fixture.change.change_id,'draft',rawHash(broken)+'.yaml'),'utf8'),broken);
  await context.close();
 }finally{await browser.close();await fixture.cleanup();}
});
