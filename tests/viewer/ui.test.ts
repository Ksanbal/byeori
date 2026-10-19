import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { parseDocument } from '../../src/core/documents';
import type { Catalog, ViewerDocument, ViewerSource } from '../../src/viewer/types';
import { DOCUMENT_KINDS } from '../../src/contracts/documents';

/** DOM interaction coverage supplements, but never claims to replace, a real browser run. */
test('real React/Kumo viewer supports tabs, hierarchy, detail, search, source, navigation and read-only refresh', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:4317/', pretendToBeVisual: true });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  install('cancelAnimationFrame', clearTimeout);
  install('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let viewportWidth=1280;
  dom.window.matchMedia = (query: string) => ({ matches: query==='(min-width: 851px)' ? viewportWidth>=851 : query==='(max-width: 850px)' ? viewportWidth<=850 : false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  const documents: ViewerDocument[] = [];
  for (const kind of DOCUMENT_KINDS) {
    const parsed = parseDocument({path:`planning/source/${kind}.yaml`,raw:await readFile(new URL(`../fixtures/planning/${kind}.yaml`, import.meta.url),'utf8')});
    documents.push({ ...parsed, title: parsed.projection.title, summary: parsed.projection.summary, semantic_hash: parsed.content_hash, provenance:'source' });
  }
  const ia = documents.find(doc => doc.kind === 'ia')!;
  if (ia.projection.kind === 'ia') ia.projection.nodes.push({id:'NAV-CHILD', label:'하위 상담 화면', screen_id:'SCR-MSG-001', parent_id:'NAV-CHAT'});
  const source: ViewerSource = {id:'source',kind:'source',change_id:null,label:'Current source',path:'planning/source',status:'source',version:null};
  const draft: ViewerSource = {id:'change:change-one',kind:'draft',change_id:'change-one',label:'New generated planning',path:'planning/changes/change-one',status:'draft',version:'version-one'};
  let catalog: Catalog = {schema_version:1,workspace:{name:'Synthetic UI test',source_path:'planning/source'},mode:'read-only',provenance:'source',sources:[source,draft],selected_source:source,invalid_documents:[],draft_edits:[],loaded_at:'2026-01-01T00:00:00Z',kinds:DOCUMENT_KINDS.map(kind=>({kind,label:kind,count:1})),documents,relations:[{source:'IA-DEMO-001',target:'SCR-MSG-001',type:'screen',field:'nodes.screen_id',resolved:true}],issues:[],truncated:false};
  let requests=0; let fail=false; let draftCatalog: Catalog; const urls: string[]=[]; let deferNext: Promise<unknown> | null=null;
  install('fetch', async (url: string, options: RequestInit) => { assert.match(url,/^\/api\/catalog(?:\?change=change-one)?$/);urls.push(url); assert.equal(options.method,undefined); assert.equal(options.credentials,'omit'); requests++; if (deferNext) { const deferred=deferNext; deferNext=null; return deferred; } return {ok:!fail,json:async()=>url.includes('?change=')?draftCatalog:catalog}; });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App } = await import('../../src/viewer/ui/app');
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  const flush = async () => { await act(async()=>{ await new Promise(resolve=>setTimeout(resolve,30)); }); };
  const click = async (element: Element | null | undefined) => { assert.ok(element,'expected control exists'); await act(async()=>{(element as HTMLElement).click();}); await flush(); };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(element=>element.getAttribute('aria-label')===label || element.textContent===label);
  const tab = (label: string) => Array.from(container.querySelectorAll('[role="tab"]')).find(element=>element.textContent?.trim()===label);
  try {
    await act(async()=>{root.render(createElement(App));}); await flush();
    assert.equal(container.querySelectorAll('.document-tabs [role="tab"]').length,10);
    assert.equal(container.querySelectorAll('.map-card:not(.kind-card)').length,9);
    assert.match(container.textContent! ,/읽기 전용/);
    await click(tab('IA 1'));
    assert.equal(container.querySelectorAll('.hierarchy-line').length,2);
    assert.match(container.textContent!,/하위 상담 화면/);
    await click(button('NAV-CHILD 하위 상담 화면 상세 보기'));
    assert.match(container.querySelector('.inspector')!.textContent!,/선택한 하위 항목/);
    assert.match(location.hash,/item=NAV-CHILD/);
    await click(tab('YAML 원문'));
    assert.match(container.querySelector('.source-code')!.textContent!,/schema_version: 1/);
    await click(tab('읽기'));
    await click(container.querySelector('.relation-item'));
    assert.match(container.querySelector('.inspector')!.textContent!,/SCR-MSG-001/);
    await click(button('상세 닫기'));
    assert.equal(container.querySelector('.inspector'),null);
    await act(async()=>{dom.window.location.hash='#tab=ia&doc=IA-DEMO-001&item=NAV-CHILD';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();
    assert.match(container.querySelector('.inspector')!.textContent!,/선택한 하위 항목/);
    await click(button('상세 닫기'));
    await click(button('확대'));assert.match(container.querySelector('.map-controls')!.textContent!,/120%/);
    await click(button('초기 위치'));assert.match(container.querySelector('.map-controls')!.textContent!,/100%/);
    const stage=container.querySelector('.map-stage')!;
    const before=container.querySelector('.map-world')!.getAttribute('style');
    await act(async()=>{stage.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
    assert.notEqual(container.querySelector('.map-world')!.getAttribute('style'),before);
    const beforeWheel=container.querySelector('.map-world')!.getAttribute('style');
    await act(async()=>{stage.dispatchEvent(new dom.window.WheelEvent('wheel',{deltaX:40,deltaY:90,bubbles:true,cancelable:true}));});
    assert.notEqual(container.querySelector('.map-world')!.getAttribute('style'),beforeWheel);
    await act(async()=>{stage.dispatchEvent(new dom.window.WheelEvent('wheel',{deltaY:-30,ctrlKey:true,bubbles:true,cancelable:true}));});
    assert.match(container.querySelector('.map-controls')!.textContent!,/127%/);
    (stage as HTMLElement).setPointerCapture=()=>{};
    const pointer=(type:string,x:number,y:number,id=1)=>{const event=new dom.window.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,'pointerId',{value:id});stage.dispatchEvent(event);};
    await act(async()=>{pointer('pointerdown',50,50);});
    const beforeDrag=container.querySelector('.map-world')!.getAttribute('style');
    await act(async()=>{pointer('pointermove',200,200,2);});
    assert.equal(container.querySelector('.map-world')!.getAttribute('style'),beforeDrag,'a different touch cannot hijack a drag');
    await act(async()=>{pointer('pointermove',100,125);pointer('pointerup',100,125);});
    assert.notEqual(container.querySelector('.map-world')!.getAttribute('style'),beforeDrag);
    assert.equal(stage.classList.contains('dragging'),false);
    Object.defineProperties(stage,{clientWidth:{value:640,configurable:true},clientHeight:{value:480,configurable:true}});
    await click(button('전체 보기'));
    assert.notEqual(container.querySelector('.map-controls')!.textContent!.match(/([\d.]+)%/)?.[1],'127');

    const input=container.querySelector('input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'no-such-document');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await flush();
    assert.match(container.textContent!,/일치하는 문서가 없습니다/);
    await click(button('검색 지우기'));
    assert.ok(container.querySelector('.map-stage'));
    catalog={...catalog,documents:[],kinds:catalog.kinds.map(kind=>({...kind,count:0})),relations:[]};
    await click(button('새로고침'));
    assert.equal(requests,2);
    assert.match(container.textContent!,/IA 문서가 아직 없습니다/);
    assert.equal(container.querySelectorAll('.document-tabs [role="tab"]').length,10);
    const malicious={...documents[0],title:'<img src=x onerror=alert(1)>',summary:'<script>alert(1)</script>'};
    catalog={...catalog,documents:[malicious],kinds:catalog.kinds.map(kind=>({...kind,count:kind.kind==='prd'?1:0})),issues:[{code:'TEST',path:'broken.yaml',message:'<svg onload=alert(1)>'}]};
    await click(button('새로고침'));await click(tab('PRD 1'));
    assert.equal(container.querySelectorAll('img,script,svg[onload]').length,0);
    assert.match(container.textContent!,/<img src=x onerror=alert\(1\)>/);
    await click(button('자세히 보기'));
    assert.match(container.querySelector('.issues-panel')!.textContent!,/<svg onload=alert\(1\)>/);
    assert.equal(container.querySelectorAll('button').length>0,true);
    assert.equal(Array.from(container.querySelectorAll('button')).some(element=>/승인|저장|편집/.test(element.textContent!)),false);
    // A present but wrong-kind target must not be rendered as a resolved relation.
    catalog={...catalog,documents,relations:[{source:ia.id,target:documents[0].id,type:'screen',field:'nodes[0].screen_id',resolved:false}],issues:[],kinds:catalog.kinds.map(kind=>({...kind,count:1}))};
    await click(button('새로고침'));await click(tab('IA 1'));
    await click(button('IA-DEMO-001 상담 메뉴 구조 상세 보기'));
    assert.match(container.querySelector('.unresolved-relation')!.textContent!,/종류가 일치하지 않습니다/);
    await click(button('상세 닫기'));

    // Generated draft-only content, including invalid YAML and non-put intents, is inspectable.
    const incomplete={id:'FEAT-BROKEN',kind:'feature' as const,path:'planning/source/broken.yaml',storage_path:'planning/changes/change-one/drafts/broken.yaml',raw:'kind: feature\ntitle: <img src=x onerror=alert(1)>\n',raw_hash:'0'.repeat(64),provenance:'draft' as const,issues:[{code:'INVALID_DOCUMENT',path:'planning/source/broken.yaml',message:'Missing required fields'}]};
    draftCatalog={...catalog,provenance:'draft',selected_source:draft,documents:[{...documents[0],title:'Generated draft PRD',provenance:'draft',storage_path:'planning/changes/change-one/drafts/prd.yaml'}],invalid_documents:[incomplete],draft_edits:[{operation:'delete',object_id:'SCR-OLD',kind:'screen',path:null,storage_path:null}],relations:[],kinds:catalog.kinds.map(kind=>({...kind,count:kind.kind==='prd'||kind.kind==='feature'?1:0}))};
    const chooseSource=async(value:string)=>{await act(async()=>{const control=container.querySelector('select')!;control.value=value;control.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});await flush();};
    await chooseSource('change-one');
    assert.equal(urls.at(-1),'/api/catalog?change=change-one');
    assert.match(location.hash,/change=change-one/);
    assert.match(container.querySelector('.source-toolbar')!.textContent!,/현재 소스와 합치지 않음/);
    assert.equal(container.querySelectorAll('.map-card:not(.kind-card)').length,2);
    assert.equal(container.querySelectorAll('.invalid-card').length,1);
    assert.ok(tab('기능정의서 1'));
    await click(container.querySelector('.invalid-card'));
    assert.match(container.querySelector('[aria-label="미완성 초안 상세"]')!.textContent!,/Missing required fields/);
    assert.match(container.querySelector('.source-code')!.textContent!,/<img src=x onerror=alert\(1\)>/);
    assert.equal(container.querySelectorAll('img,script').length,0);
    await click(button('상세 닫기'));await click(tab('PRD 1'));
    assert.match(location.hash,/change=change-one/);
    await click(button('PRD-DEMO-001 Generated draft PRD 상세 보기'));
    assert.match(container.querySelector('.source-note')!.textContent!,/저장된 초안/);
    assert.match(container.querySelector('.file-path')!.textContent!,/planning\/changes\/change-one/);
    await click(button('상세 닫기'));
    await click(container.querySelector('.draft-operations>button'));
    assert.match(container.querySelector('.draft-operations')!.textContent!,/SCR-OLD/);
    await chooseSource('');
    assert.doesNotMatch(location.hash,/change=/);
    assert.doesNotMatch(container.querySelector('.map-world')!.textContent!,/Generated draft PRD|FEAT-BROKEN/);
    assert.equal(container.querySelector('.draft-operations'),null);

    // Failure retains the explicitly labeled old catalog; retry restores it.
    fail=true;await click(button('새로고침'));
    assert.match(container.querySelector('.notice')!.textContent!,/이전에 불러온 내용을 표시합니다/);
    assert.equal(container.querySelectorAll('.map-card:not(.kind-card)').length,9);
    fail=false;await click(button('다시 시도'));
    assert.equal(container.querySelector('.notice.error'),null);

    // A slow, aborted draft response must never replace a newer source selection.
    let finishSlow!: (value:unknown)=>void;
    deferNext=new Promise(resolve=>{finishSlow=resolve;});
    await chooseSource('change-one');
    await chooseSource('');
    await act(async()=>{finishSlow({ok:true,json:async()=>draftCatalog});});await flush();
    assert.equal(container.querySelector('select')!.value,'');
    assert.equal(container.querySelectorAll('.map-card:not(.kind-card)').length,9);
    assert.doesNotMatch(container.querySelector('.map-world')!.textContent!,/Generated draft PRD/);

    // Hash navigation restores the selected draft scope and its raw-only inspector.
    await act(async()=>{dom.window.location.hash='#tab=feature&change=change-one&doc=FEAT-BROKEN';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();
    assert.equal(container.querySelector('select')!.value,'change-one');
    assert.match(container.querySelector('[aria-label="미완성 초안 상세"]')!.textContent!,/FEAT-BROKEN/);
    await act(async()=>{dom.window.location.hash='#tab=all';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await flush();
    assert.equal(container.querySelector('select')!.value,'');
    assert.equal(container.querySelector('.inspector'),null);

    // Narrow-screen list toggles remain useful and selecting a document dismisses the drawer.
    viewportWidth=390;
    await click(button('문서 목록 숨기기'));assert.equal(container.querySelector('.outline'),null);
    await click(button('문서 목록 열기'));assert.ok(container.querySelector('.outline'));
    assert.equal(button('문서 목록 숨기기')!.getAttribute('aria-expanded'),'true');
    await click(container.querySelector('.outline-item'));
    assert.equal(container.querySelector('.outline'),null);
    assert.ok(container.querySelector('.inspector'));
    await act(async()=>{const searchInput=container.querySelector('input')!;Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(searchInput,'no-mobile-result');searchInput.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await flush();
    assert.equal(container.querySelector('.inspector'),null,'mobile search must reveal its result area');
    assert.match(container.textContent!,/일치하는 문서가 없습니다/);
    await click(button('검색 지우기'));
    assert.ok(button('문서 목록 열기'));


  } finally { await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous) { if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key); } }
});
