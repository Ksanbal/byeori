import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { Input } from '@cloudflare/kumo/components/input';
import { Badge } from '@cloudflare/kumo/components/badge';
import { ArrowClockwiseIcon, ArrowsOutIcon, MagnifyingGlassIcon, MinusIcon, PlusIcon, XIcon, ArrowUpRightIcon, LockSimpleIcon, SidebarSimpleIcon } from '@phosphor-icons/react';
import { DOCUMENT_KINDS, type DocumentKind, type JsonValue } from '../../contracts/documents';
import type { Catalog, ViewerDocument, ViewerInvalidDocument, ViewerSource } from '../types';
import { KIND_INFO, buildIaOutline, buildMap, docFields, fieldLabel, matchesDocument, matchesInvalidDocument, navigationHash, nodeKey, parseNavigation, type Navigation, type MapLayout, type OutlineNode } from './model';

function ValueTree({ label, value, depth = 0 }: { label: string; value: JsonValue; depth?: number }) {
  const [open, setOpen] = useState(depth < 1), [limit, setLimit] = useState(30);
  if (value === null || typeof value !== 'object') return <div className="value-line"><span>{fieldLabel(label)}</span><p>{value === null ? '없음' : typeof value === 'boolean' ? value ? '예' : '아니요' : String(value)}</p></div>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value);
  return <details className="value-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{fieldLabel(label)}</span><span className="count">{entries.length}</span></summary>
    {open && <div className="value-children">{entries.length ? entries.slice(0, limit).map(([key, item]) => <ValueTree key={key} label={key} value={item} depth={depth + 1} />) : <p className="muted empty-value">아직 항목이 없습니다</p>}{entries.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit(limit + 30)}>다음 30개 보기 ({entries.length - limit}개 남음)</Button>}</div>}
  </details>;
}

function IaBranches({ nodes, documentId, navigation, select, depth = 0 }: { nodes: OutlineNode[]; documentId: string; navigation: Navigation; select: (id: string, element?: string) => void; depth?: number }) {
  const containsSelection = (node: OutlineNode): boolean => node.item.id === navigation.elementId || node.children.some(containsSelection);
  return <>{nodes.map(node => <li key={node.item.id}>
    <button className={`outline-item ${navigation.elementId === node.item.id && navigation.documentId === documentId ? 'selected' : ''}`} aria-current={navigation.elementId === node.item.id && navigation.documentId === documentId ? 'true' : undefined} onClick={() => select(documentId, node.item.id)}><span className="branch-dot" /><span>{node.item.label}</span></button>
    {node.children.length > 0 && <details open={depth < 2 || containsSelection(node)} className="subtree"><summary>하위 항목 <span className="count">{node.children.length}</span></summary><ul><IaBranches nodes={node.children} documentId={documentId} navigation={navigation} select={select} depth={depth + 1} /></ul></details>}
  </li>)}</>;
}

function IaOutline({ doc, navigation, select }: { doc: ViewerDocument; navigation: Navigation; select: (id: string, element?: string) => void }) {
  const outline = useMemo(() => buildIaOutline(doc.projection.kind === 'ia' ? doc.projection.nodes : []), [doc]);
  return <ul className="ia-outline"><IaBranches nodes={outline.nodes} documentId={doc.id} navigation={navigation} select={select} />{outline.truncated && <li className="muted">목록은 최대 200개 항목·32단계 표시 · 전체는 문서 상세에서 확인</li>}</ul>;
}

interface Viewport { x: number; y: number; scale: number }
function WorkspaceMap({ layout, navigation, select, pickKind, focusToken }: { layout: MapLayout; navigation: Navigation; select: (id: string, item?: string) => void; pickKind: (kind: DocumentKind) => void; focusToken: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 24, y: 24, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const fit = useCallback(() => {
    if (!stage.current) return;
    const { clientWidth: width, clientHeight: height } = stage.current;
    const scale = Math.max(.001, Math.min(1, Math.max(1, width - 60) / layout.width, Math.max(1, height - 60) / layout.height));
    setView({ x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2, scale });
  }, [layout.width, layout.height]);
  const zoom = useCallback((factor: number, position?: { x: number; y: number }) => {
    setView(current => {
      const scale = Math.max(.001, Math.min(2, current.scale * factor)), ratio = scale / current.scale;
      const anchor = position ?? { x: (stage.current?.clientWidth ?? 600) / 2, y: (stage.current?.clientHeight ?? 500) / 2 };
      return { x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio, scale };
    });
  }, []);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * .008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      } else setView(current => ({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? event.deltaX : event.deltaY) }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom]);
  useEffect(() => { setView({ x: 24, y: 24, scale: 1 }); }, [navigation.kind, navigation.changeId]);
  useEffect(() => {
    if (!navigation.documentId) return;
    const node = layout.nodes.find(item => item.key === nodeKey(navigation.documentId!, navigation.elementId ?? undefined));
    if (node && stage.current) setView(current => ({ ...current, x: stage.current!.clientWidth / 2 - (node.x + node.width / 2) * current.scale, y: stage.current!.clientHeight / 2 - (node.y + node.height / 2) * current.scale }));
  }, [focusToken, navigation.documentId, navigation.elementId, layout]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const delta: Record<string, [number, number]> = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
    if (delta[event.key]) { event.preventDefault(); setView(current => ({ ...current, x: current.x + delta[event.key][0], y: current.y + delta[event.key][1] })); }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
    if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
    if (event.key === '0') { event.preventDefault(); fit(); }
  };
  const byKey = new Map(layout.nodes.map(node => [node.key, node]));
  return <div className="map-shell">
    <div ref={stage} className={`map-stage ${dragging ? 'dragging' : ''}`} tabIndex={0} role="region" aria-label="2D 문서 지도. 방향키로 이동, 더하기 빼기로 확대 축소, 0으로 전체 보기" onKeyDown={keyboard}
      onPointerDown={event => { if (drag.current || (event.target as HTMLElement).closest('button') || event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId }; setDragging(true); }}
      onPointerMove={event => { if (!drag.current || event.pointerId !== drag.current.pointer) return; const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y; drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId }; setView(current => ({ ...current, x: current.x + dx, y: current.y + dy })); }}
      onPointerUp={() => { drag.current = null; setDragging(false); }} onPointerCancel={() => { drag.current = null; setDragging(false); }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}>
      <div className="map-world" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="map-lines" width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a3a6ab" /></marker></defs>{layout.edges.map((edge, index) => {
          const from = byKey.get(edge.from), to = byKey.get(edge.to); if (!from || !to) return null;
          const x1 = from.x + from.width, y1 = from.y + from.height / 2, x2 = to.x, y2 = to.y + to.height / 2;
          return <g key={index}><path className={edge.hierarchy ? 'hierarchy-line' : 'relation-line'} d={`M${x1},${y1} C${x1 + 48},${y1} ${x2 - 48},${y2} ${x2},${y2}`} markerEnd="url(#edge-arrow)" /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle">{edge.label}</text></g>;
        })}</svg>
        {layout.nodes.map(node => <button key={node.key} className={`map-card ${!node.documentId ? 'kind-card' : ''} ${node.elementId ? 'element-card' : ''} ${node.empty ? 'empty-card' : ''} ${node.invalid ? 'invalid-card' : ''} ${node.key === nodeKey(navigation.documentId ?? '', navigation.elementId ?? undefined) ? 'selected' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height, '--kind-color': `var(--${node.kind})` } as CSSProperties} onClick={() => node.documentId ? select(node.documentId, node.elementId) : pickKind(node.kind)} aria-label={node.documentId ? `${node.eyebrow} ${node.title} 상세 보기` : `${node.title} 문서 탐색`}>
          <span className="card-eyebrow"><span className="kind-mark">{KIND_INFO[node.kind].symbol}</span>{node.eyebrow}<ArrowUpRightIcon size={14} /></span>
          <strong>{node.title}</strong><p>{node.summary}</p>
          {node.items.length > 0 && <span className="card-subitems">{node.items.map(item => <span key={item}>{item}</span>)}</span>}
          {node.empty && <span className="empty-label">아직 생성된 문서 없음</span>}
        </button>)}
      </div>
    </div>
    {layout.truncated && <div className="map-limit" role="status">큰 문서의 지도는 최대 1,000개 항목·2,000개 연결·32단계까지 표시합니다. 전체 내용은 상세와 YAML 원문에서 확인하세요.</div>}
    <div className="map-hint">빈 공간을 드래그하거나 스크롤해 이동 · Ctrl/⌘ + 스크롤로 확대</div>
    <div className="map-controls" aria-label="지도 배율"><Button variant="ghost" shape="square" size="sm" aria-label="축소" onClick={() => zoom(1 / 1.2)}><MinusIcon /></Button><span aria-live="polite">{view.scale < .01 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100)}%</span><Button variant="ghost" shape="square" size="sm" aria-label="확대" onClick={() => zoom(1.2)}><PlusIcon /></Button><i /><Button variant="ghost" size="sm" onClick={fit}><ArrowsOutIcon />전체 보기</Button><Button variant="ghost" size="sm" onClick={() => setView({ x: 24, y: 24, scale: 1 })}>초기 위치</Button></div>
  </div>;
}

function Inspector({ document, catalog, elementId, onClose, select }: { document: ViewerDocument; catalog: Catalog; elementId: string | null; onClose: () => void; select: (id: string) => void }) {
  const [tab, setTab] = useState('read'), [relationLimit, setRelationLimit] = useState(100);
  const fields = docFields(document);
  let element: JsonValue | undefined;
  if (elementId) for (const [, value] of fields) if (Array.isArray(value)) element ??= value.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.id === elementId);
  const references = catalog.relations.filter(relation => relation.source === document.id || relation.target === document.id);
  return <aside className="inspector" aria-label="문서 상세">
    <div className="inspector-heading"><span className="eyebrow">DOCUMENT DETAILS</span><Button variant="ghost" shape="square" size="sm" aria-label="상세 닫기" onClick={onClose}><XIcon /></Button></div>
    <div className="document-heading"><Badge>{KIND_INFO[document.kind].label}</Badge><h2>{document.title}</h2><p>{document.summary}</p><span className="document-id">{document.id}</span></div>
    <Tabs tabs={[{ value: 'read', label: '읽기' }, { value: 'source', label: 'YAML 원문' }]} value={tab} onValueChange={value => setTab(String(value))} variant="underline" className="inspector-tabs" />
    <div className="inspector-content" role="region" aria-label={tab === 'read' ? '문서 내용' : 'YAML 원문'} tabIndex={0}>
      <div className="source-note"><LockSimpleIcon size={14} /><span>{document.provenance === 'draft' ? '저장된 초안 · 적용·승인 여부 미검증' : 'planning/source의 현재 내용 · 승인 상태를 나타내지 않습니다'}</span></div>
      {tab === 'source' ? <pre className="source-code">{document.raw}</pre> : <>
        {element && <section className="selected-element"><div className="eyebrow">선택한 하위 항목</div><ValueTree key={elementId} label={elementId!} value={element} /></section>}
        {fields.map(([key, value]) => <ValueTree key={document.id + key} label={key} value={value} />)}
        <section className="relations"><h3>문서 연결 <span className="count">{references.length}</span></h3><p className="muted">원문에 명시된 참조만 표시합니다</p>
          {!references.length && <p className="muted">이 문서에 명시된 연결이 없습니다</p>}
          {references.slice(0, relationLimit).map((relation, index) => { const outgoing = relation.source === document.id; const id = outgoing ? relation.target : relation.source; const target = catalog.documents.find(doc => doc.id === id); const resolved = relation.resolved && Boolean(target); return <button key={index} className={`relation-item ${resolved ? '' : 'unresolved-relation'}`} onClick={() => target && select(id)} disabled={!target}><span>{outgoing ? '→' : '←'}</span><span><strong>{target?.title ?? id}</strong><small>{relation.type} · {relation.field}</small>{!resolved && <small className="warning-text">{!target ? '선택한 문서 소스에 대상 없음' : '참조한 문서의 종류가 일치하지 않습니다'}</small>}</span><ArrowUpRightIcon size={14} /></button>; })}
          {references.length > relationLimit && <Button variant="ghost" size="sm" onClick={() => setRelationLimit(relationLimit + 100)}>연결 더 보기 ({references.length - relationLimit}개 남음)</Button>}
        </section>
      </>}
      <div className="file-path"><span className="eyebrow">SOURCE FILE</span><p>{document.storage_path ?? document.path}</p>{document.storage_path && <><span className="eyebrow">TARGET PATH</span><p>{document.path}</p></>}</div>
    </div>
  </aside>;
}

const SOURCE_STATUS: Record<ViewerSource['status'], string> = {
  source: '현재 소스', draft: '작성 중 초안', 'review-recorded': '검토 기록 있음',
  'applied-recorded': '적용 기록 있음', 'cancelled-recorded': '취소 기록 있음', invalid: '읽기 확인 필요',
};

function InvalidInspector({ document, onClose }: { document: ViewerInvalidDocument; onClose: () => void }) {
  return <aside className="inspector" aria-label="미완성 초안 상세">
    <div className="inspector-heading"><span className="eyebrow">DRAFT SOURCE</span><Button variant="ghost" shape="square" size="sm" aria-label="상세 닫기" onClick={onClose}><XIcon /></Button></div>
    <div className="document-heading"><Badge>{KIND_INFO[document.kind].label}</Badge><h2>{document.id}</h2><p>아직 구조 검증을 통과하지 못한 초안입니다. 저장된 YAML 원문을 그대로 표시합니다.</p></div>
    <div className="inspector-content" role="region" aria-label="미완성 초안 원문" tabIndex={0}>
      <div className="source-note draft-note"><LockSimpleIcon size={14} /><span>저장된 초안 · 적용·승인 여부 미검증</span></div>
      {document.issues.map((issue, index) => <p className="validation-issue" key={index}>{issue.message}</p>)}
      <pre className="source-code">{document.raw}</pre>
      <div className="file-path"><span className="eyebrow">DRAFT FILE</span><p>{document.storage_path}</p><span className="eyebrow">TARGET PATH</span><p>{document.path}</p></div>
    </div>
  </aside>;
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [navigation, setNavigation] = useState(() => parseNavigation(location.hash)), [query, setQuery] = useState(''), [sidebar, setSidebar] = useState(() => window.matchMedia('(min-width: 851px)').matches), [issuesOpen, setIssuesOpen] = useState(false), [focusToken, setFocusToken] = useState(0), [knownSources, setKnownSources] = useState<ViewerSource[]>([]), [editsOpen, setEditsOpen] = useState(false);
  const request = useRef<AbortController | null>(null), search = useRef<HTMLInputElement>(null);
  const reload = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError(null);
    try { const response = await fetch('/api/catalog' + (navigation.changeId ? '?change=' + encodeURIComponent(navigation.changeId) : ''), { signal: controller.signal, cache: 'no-store', credentials: 'omit' }); if (!response.ok) throw new Error('문서를 읽지 못했습니다. 로컬 서버와 프로젝트 경로를 확인하세요.'); const data: Catalog = await response.json(); if (data.schema_version !== 1 || !Array.isArray(data.documents) || !Array.isArray(data.sources) || !Array.isArray(data.invalid_documents) || !data.selected_source) throw new Error('지원하지 않는 문서 응답입니다.'); if (!controller.signal.aborted) { setCatalog(data); setKnownSources(data.sources); } }
    catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '문서를 읽지 못했습니다'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [navigation.changeId]);
  useEffect(() => { setCatalog(null); setIssuesOpen(false); setEditsOpen(false); void reload(); return () => request.current?.abort(); }, [reload]);
  useEffect(() => { const change = () => { const next = parseNavigation(location.hash); setNavigation(next); if (next.documentId) setQuery(''); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { const key = (event: globalThis.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); search.current?.focus(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const navigate = (next: Navigation) => { setNavigation(next); if (location.hash !== navigationHash(next)) location.hash = navigationHash(next); };
  const pickKind = (kind: DocumentKind | 'all') => { navigate({ ...navigation, kind, documentId: null, elementId: null }); };
  const select = (id: string, element?: string) => { const doc = catalog?.documents.find(item => item.id === id) ?? catalog?.invalid_documents.find(item => item.id === id); if (!doc) return; if (window.matchMedia('(max-width: 850px)').matches) setSidebar(false); setQuery(''); navigate({ ...navigation, kind: navigation.kind === 'all' && !element ? 'all' : doc.kind, documentId: id, elementId: element ?? null }); setFocusToken(value => value + 1); };
  const documents = useMemo(() => catalog?.documents.filter(doc => (navigation.kind === 'all' || doc.kind === navigation.kind) && matchesDocument(doc, query)) ?? [], [catalog, navigation.kind, query]);
  const invalidDocuments = useMemo(() => catalog?.invalid_documents.filter(doc => (navigation.kind === 'all' || doc.kind === navigation.kind) && matchesInvalidDocument(doc, query)) ?? [], [catalog, navigation.kind, query]);
  const documentCount = documents.length + invalidDocuments.length;
  const layout = useMemo(() => buildMap(documents, navigation.kind, invalidDocuments), [documents, navigation.kind, invalidDocuments]);
  const selected = catalog?.documents.find(doc => doc.id === navigation.documentId);
  const selectedInvalid = catalog?.invalid_documents.find(doc => doc.id === navigation.documentId);
  const closeInspector = () => navigate({ ...navigation, documentId: null, elementId: null });
  const selectSource = (changeId: string) => { setCatalog(null); setQuery(''); navigate({ kind: 'all', documentId: null, elementId: null, ...(changeId ? { changeId } : {}) }); };
  const draftOperations = catalog?.draft_edits.filter(edit => edit.operation !== 'put') ?? [];
  const info = navigation.kind === 'all' ? { label: '문서 지도', english: 'DOCUMENT EXPLORER', description: '제품의 큰 그림부터 세부 정의까지, 연결된 문서를 자유롭게 탐색하세요.' } : KIND_INFO[navigation.kind];
  const issueCount = catalog?.issues.length ?? 0;
  return <div className="app">
    <header className="topbar"><a className="brand" href={navigationHash({ kind: 'all', documentId: null, elementId: null, changeId: navigation.changeId })} aria-label="Byeori 문서 지도"><span className="brand-mark">✳</span><strong>byeori</strong><span>벼리</span></a><span className="header-divider" /><span className="workspace-name">{catalog?.workspace.name ?? '문서 탐색'}</span><div className="header-actions"><span className="read-only"><LockSimpleIcon size={13} />읽기 전용</span><Button variant="secondary" size="sm" onClick={() => void reload()} disabled={loading}><ArrowClockwiseIcon className={loading ? 'spinning' : ''} />새로고침</Button></div></header>
    <div className={`source-toolbar ${catalog?.provenance === 'draft' ? 'draft-source' : ''}`}>
      <label htmlFor="document-source">문서 소스</label>
      <select id="document-source" value={navigation.changeId ?? ''} onChange={event => selectSource(event.target.value)} aria-label="문서 소스 선택">
        <option value="">현재 소스 · planning/source</option>
        {knownSources.filter(source => source.kind === 'draft').map(source => <option key={source.id} value={source.change_id!}>{source.label} · {source.change_id?.slice(0, 8)} · {SOURCE_STATUS[source.status]}</option>)}
        {navigation.changeId && !knownSources.some(source => source.change_id === navigation.changeId) && <option value={navigation.changeId}>{navigation.changeId}</option>}
      </select>
      {catalog && <><span className="source-status">{SOURCE_STATUS[catalog.selected_source.status]}</span><span className="source-disclaimer">{catalog.provenance === 'draft' ? '이 변경 세트의 초안만 표시 · 현재 소스와 합치지 않음 · 승인 여부 미검증' : '현재 파일 내용 · 승인 여부 미검증'}</span>{catalog.selected_source.version && <span className="source-version" title={catalog.selected_source.version}>v {catalog.selected_source.version.slice(0, 12)}</span>}</>}
    </div>
    <nav className="document-tabs" aria-label="문서 종류"><Tabs variant="underline" value={navigation.kind} onValueChange={value => pickKind(value as DocumentKind | 'all')} tabs={[{ value: 'all', label: <span>전체 지도 <em>{catalog ? catalog.documents.length + catalog.invalid_documents.length : 0}</em></span> }, ...DOCUMENT_KINDS.map(kind => ({ value: kind, label: <span>{KIND_INFO[kind].label} <em>{catalog?.kinds.find(item => item.kind === kind)?.count ?? 0}</em></span> }))]} /></nav>
    <section className="explorer-heading"><div><span className="eyebrow">{info.english}</span><h1>{info.label}<span>{documentCount} documents</span></h1><p>{info.description}</p></div><div className="searchbox"><MagnifyingGlassIcon size={18} /><Input ref={search} aria-label="문서 검색" placeholder="제목, ID, 문서 내용 검색" value={query} onChange={event => { setQuery(event.target.value); if (navigation.documentId) closeInspector(); }} /><kbd>⌘ K</kbd>{query && <button aria-label="검색 지우기" onClick={() => setQuery('')}><XIcon /></button>}</div></section>
    {catalog?.provenance === 'source' && !catalog.documents.length && knownSources.some(source => source.kind === 'draft') && <div className="draft-discovery" role="status">생성된 초안이 있습니다. 상단 문서 소스에서 변경 세트를 선택해 PRD와 기능정의서를 확인하세요.</div>}
    {(error || issueCount > 0 || catalog?.truncated) && <div className={`notice ${error ? 'error' : ''}`} role="status"><span>{error ? `${error}${catalog ? ' 이전에 불러온 내용을 표시합니다.' : ''}` : `${issueCount}개 읽기·참조 알림${catalog?.truncated ? ' · 표시 한도에 도달했습니다' : ''}`}</span>{issueCount > 0 && <Button variant="ghost" size="sm" onClick={() => setIssuesOpen(!issuesOpen)}>{issuesOpen ? '알림 닫기' : '자세히 보기'}</Button>}{error && <Button size="sm" variant="ghost" onClick={() => void reload()}>다시 시도</Button>}</div>}
    {issuesOpen && catalog && <div className="issues-panel">{catalog.issues.map((issue, index) => <div key={index}><strong>{issue.path ?? issue.code}</strong><p>{issue.message}</p></div>)}</div>}
    {draftOperations.length > 0 && <div className="draft-operations"><button onClick={() => setEditsOpen(!editsOpen)} aria-expanded={editsOpen}>{editsOpen ? '⌄' : '›'} 이동·삭제 항목 {draftOperations.length}개 <span>기록만 표시 · 뷰어에서 실행하지 않음</span></button>{editsOpen && <ul>{draftOperations.map((edit, index) => <li key={index}><Badge>{edit.operation === 'move' ? '이동' : '삭제'}</Badge><strong>{edit.object_id}</strong>{edit.path && <span>{edit.path}</span>}</li>)}</ul>}</div>}
    <main className={`explorer ${sidebar ? '' : 'sidebar-hidden'} ${selected || selectedInvalid ? 'with-inspector' : ''}`}>
      {sidebar && <aside id="document-outline" className="outline" aria-label="문서 목록"><div className="outline-heading"><span className="eyebrow">EXPLORER</span><span className="count">{documentCount}</span></div><div className="outline-scroll">{DOCUMENT_KINDS.filter(kind => navigation.kind === 'all' || kind === navigation.kind).map(kind => { const items = documents.filter(doc => doc.kind === kind); const incomplete = invalidDocuments.filter(doc => doc.kind === kind); return <details className="outline-group" key={kind} open><summary><span className="kind-icon" style={{ color: `var(--${kind})` }}>{KIND_INFO[kind].symbol}</span>{KIND_INFO[kind].label}<span className="count">{items.length + incomplete.length}</span></summary><ul>{items.map(doc => <li key={doc.id}><button className={`outline-item ${selected?.id === doc.id && !navigation.elementId ? 'selected' : ''}`} onClick={() => select(doc.id)}><span className="file-symbol">▧</span><span>{doc.title}<small>{doc.id}</small></span></button>{doc.kind === 'ia' && <IaOutline doc={doc} navigation={navigation} select={select} />}</li>)}{incomplete.map(doc => <li key={doc.id}><button className={`outline-item ${selectedInvalid?.id === doc.id ? 'selected' : ''}`} onClick={() => select(doc.id)}><span className="file-symbol">!</span><span>{doc.id}<small>미완성 초안 · 원문 보기</small></span></button></li>)}</ul>{!items.length && !incomplete.length && <p className="outline-empty">{query ? '검색 결과 없음' : '아직 생성되지 않음'}</p>}</details>; })}</div><div className="outline-footer"><span className="local-dot" />로컬 파일에서 읽음<small>{catalog?.selected_source.path ?? '로컬 프로젝트'}</small></div></aside>}
      <section className="canvas-area" aria-label="문서 탐색 공간"><div className="canvas-toolbar"><Button variant="ghost" shape="square" size="sm" aria-label={sidebar ? '문서 목록 숨기기' : '문서 목록 열기'} aria-expanded={sidebar} aria-controls="document-outline" onClick={() => setSidebar(!sidebar)}><SidebarSimpleIcon /></Button><span>{query ? `검색 결과 ${documentCount}개` : navigation.kind === 'ia' ? '계층 구조 · parent_id 기준' : navigation.kind === 'architecture' ? '구성 요소 · 명시된 연결' : '2D 공간'}</span><span className="canvas-toolbar-end">선택하면 상세 열기</span></div>
        {!catalog && loading ? <div className="empty-state"><span className="spinning empty-symbol">✳</span><h2>문서를 불러오는 중</h2><p>선택한 문서 소스를 안전하게 읽고 있습니다</p></div> : !catalog ? <div className="empty-state"><span className="empty-symbol">!</span><h2>문서를 불러올 수 없습니다</h2><p>서버가 실행 중인지 확인한 뒤 다시 시도하세요</p><Button onClick={() => void reload()} variant="secondary">다시 시도</Button></div> : !documentCount && (navigation.kind !== 'all' || query) ? <div className="empty-state"><span className="empty-symbol">{navigation.kind !== 'all' ? KIND_INFO[navigation.kind].symbol : '⌕'}</span><span className="eyebrow">{query ? 'NO SEARCH RESULTS' : 'WAITING FOR A DOCUMENT'}</span><h2>{query ? '일치하는 문서가 없습니다' : `${info.label} 문서가 아직 없습니다`}</h2><p>{query ? '다른 검색어를 입력하거나 검색을 지워보세요.' : `${info.description} ${catalog.provenance === 'draft' ? '이 변경 세트에 저장된 초안만 표시합니다.' : '새로 생성된 초안은 상단 문서 소스에서 변경 세트를 선택하세요.'}`}</p>{query && <Button variant="secondary" onClick={() => setQuery('')}>검색 지우기</Button>}</div> : <WorkspaceMap layout={layout} navigation={navigation} select={select} pickKind={pickKind} focusToken={focusToken} />}
      </section>
      {selected && catalog && <Inspector key={selected.id} document={selected} catalog={catalog} elementId={navigation.elementId} select={select} onClose={closeInspector} />}
      {selectedInvalid && <InvalidInspector key={selectedInvalid.id} document={selectedInvalid} onClose={closeInspector} />}
    </main>
    <footer className="statusbar"><span><span className="local-dot" />LOCAL DOCUMENT VIEWER</span><span>{catalog ? `${new Date(catalog.loaded_at).toLocaleTimeString('ko-KR')} 읽음` : '연결 중'} · 편집과 승인은 터미널에서</span><span>Byeori / Kumo UI</span></footer>
  </div>;
}
