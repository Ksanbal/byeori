import { DOCUMENT_KINDS, type DocumentKind, type InformationArchitecture, type JsonValue } from '../../contracts/documents';
import type { ViewerDocument, ViewerInvalidDocument } from '../types';

export const KIND_INFO: Record<DocumentKind, { label: string; english: string; description: string; symbol: string }> = {
  prd: { label: 'PRD', english: 'Product requirements', description: '제품의 목적, 목표, 범위와 제약을 한곳에서 확인합니다.', symbol: '◎' },
  actor: { label: '사용자', english: 'Actors & permissions', description: '누가 제품을 사용하며 어떤 역할과 권한을 갖는지 정의합니다.', symbol: '♙' },
  scenario: { label: '시나리오', english: 'User scenarios', description: '사용자의 행동과 결과를 순서대로 따라갑니다.', symbol: '↗' },
  feature: { label: '기능정의서', english: 'Feature specifications', description: '기능의 규칙과 인수 조건을 구체적으로 살펴봅니다.', symbol: '◇' },
  ia: { label: 'IA', english: 'Information architecture', description: '메뉴와 화면의 상하 관계를 트리로 탐색합니다.', symbol: '⑂' },
  screen: { label: '화면정의서', english: 'Screen specifications', description: '화면의 구성 요소, 동작과 상태를 확인합니다.', symbol: '▣' },
  entity: { label: '데이터', english: 'Data entities', description: '데이터 필드, 기본 키와 제약 조건을 확인합니다.', symbol: '▤' },
  openapi: { label: 'API', english: 'OpenAPI contracts', description: 'API 경로와 요청·응답, 연결된 기능을 살펴봅니다.', symbol: '↔' },
  architecture: { label: '아키텍처', english: 'System architecture', description: '시스템 구성 요소와 명시된 연결, 설계 결정을 탐색합니다.', symbol: '⬡' },
};
export const FIELD_LABELS: Record<string, string> = { purpose: '목적', goals: '목표', in_scope: '포함 범위', out_of_scope: '제외 범위', constraints: '제약 조건', responsibilities: '역할과 책임', permissions: '권한', actors: '사용자', preconditions: '사전 조건', steps: '진행 단계', outcomes: '결과', rules: '기능 규칙', acceptance_criteria: '인수 조건', nodes: '메뉴 계층', components: '구성 요소', states: '화면 상태', fields: '데이터 필드', primary_key: '기본 키', connections: '연결', decisions: '설계 결정', operations: 'API 작업', document: 'OpenAPI 문서', open_questions: '열린 질문', aliases: '다른 이름', id: 'ID', text: '내용', given: '조건', when: '동작', then: '기대 결과', label: '이름', screen_id: '화면', parent_id: '상위 항목', type: '유형', action: '동작', scope: '범위', actor: '사용자', result: '결과', description: '설명', name: '이름', nullable: 'Null 허용', title: '제목', responsibility: '역할', from: '출발', to: '도착', protocol: '프로토콜', blocking: '진행 차단', method: '메서드', path: '경로', content: '명세', feature_ids: '연결된 기능', operation_id: '작업 ID', pointer: '문서 위치', summary: '요약' };
export const docFields = (document: ViewerDocument): [string, JsonValue][] => Object.entries(document.projection).filter(([key]) => !['schema_version', 'id', 'kind', 'title', 'summary', 'relations'].includes(key)) as [string, JsonValue][];
export const fieldLabel = (key: string) => Object.hasOwn(FIELD_LABELS, key) ? FIELD_LABELS[key] : key;
export const matchesDocument = (document: ViewerDocument, query: string) => !query.trim() || `${document.id} ${document.title} ${document.path} ${document.raw}`.normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase());
export const matchesInvalidDocument = (document: ViewerInvalidDocument, query: string) => !query.trim() || `${document.id} ${document.path} ${document.raw}`.normalize('NFKC').toLocaleLowerCase().includes(query.trim().normalize('NFKC').toLocaleLowerCase());
export interface MapNode { key: string; documentId?: string; elementId?: string; kind: DocumentKind; x: number; y: number; width: number; height: number; title: string; summary: string; eyebrow: string; items: string[]; empty?: boolean; invalid?: boolean }
export interface MapEdge { from: string; to: string; label: string; hierarchy: boolean }
export const MAX_MAP_NODES = 1000;
export const MAX_MAP_DEPTH = 32;
export const MAX_MAP_EDGES = 2000;
export const MAX_OUTLINE_NODES = 200;
export interface OutlineNode { item: InformationArchitecture['nodes'][number]; children: OutlineNode[] }
/** Bound a root-first traversal, never the source array: YAML order carries no hierarchy. */
export function buildIaOutline(items: InformationArchitecture['nodes']): { nodes: OutlineNode[]; truncated: boolean } {
  const children = new Map<string | null, typeof items>();
  for (const item of items) { const siblings = children.get(item.parent_id); if (siblings) siblings.push(item); else children.set(item.parent_id, [item]); }
  const nodes: OutlineNode[] = [], visited = new Set<string>();
  const stack = (children.get(null) ?? []).slice().reverse().map(item => ({ item, depth: 0, destination: nodes }));
  while (stack.length && visited.size < MAX_OUTLINE_NODES) {
    const { item, depth, destination } = stack.pop()!;
    if (visited.has(item.id) || depth > MAX_MAP_DEPTH) continue;
    visited.add(item.id);
    const node: OutlineNode = { item, children: [] };
    destination.push(node);
    for (const child of (children.get(item.id) ?? []).slice().reverse()) stack.push({ item: child, depth: depth + 1, destination: node.children });
  }
  return { nodes, truncated: visited.size < items.length };
}
export interface MapLayout { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number; truncated: boolean }
export const nodeKey = (documentId: string, elementId?: string) => JSON.stringify([documentId, elementId ?? null]);
export function buildMap(documents: ViewerDocument[], kind: DocumentKind | 'all', invalidDocuments: ViewerInvalidDocument[] = []): MapLayout {
  const nodes: MapNode[] = [], edges: MapEdge[] = [];
  let truncated = false;
  const addNode = (node: MapNode) => { if (nodes.length < MAX_MAP_NODES) nodes.push(node); else truncated = true; };
  const makeDoc = (doc: ViewerDocument, x: number, y: number) => ({ key: nodeKey(doc.id), documentId: doc.id, kind: doc.kind, x, y, width: 288, height: 208, title: doc.title, summary: doc.summary, eyebrow: doc.id, items: docFields(doc).filter(([key, value]) => !['aliases', 'document', 'open_questions'].includes(key) && Array.isArray(value) && value.length).slice(0, 3).map(([key, value]) => `${fieldLabel(key)} ${(value as JsonValue[]).length}`) });
  const makeInvalid = (doc: ViewerInvalidDocument, x: number, y: number): MapNode => ({ key: nodeKey(doc.id), documentId: doc.id, kind: doc.kind, x, y, width: 288, height: 208, title: doc.id, summary: '아직 완성되지 않은 초안입니다. 원문과 검증 알림을 확인하세요.', eyebrow: KIND_INFO[doc.kind].label, items: ['검증 필요', 'YAML 원문 보기'], invalid: true });
  if (kind === 'all') {
    let rowY = 24;
    for (let row = 0; row < 3; row++) {
      let rowHeight = 0;
      for (let column = 0; column < 3; column++) {
        const current = DOCUMENT_KINDS[row * 3 + column], docs = [...documents.filter(doc => doc.kind === current), ...invalidDocuments.filter(doc => doc.kind === current)], x = column * 340 + 24;
        addNode({ key: 'kind:' + current, kind: current, x, y: rowY, width: 288, height: 102, title: KIND_INFO[current].label, summary: KIND_INFO[current].description, eyebrow: KIND_INFO[current].english, items: [], empty: !docs.length });
        docs.forEach((doc, index) => addNode('projection' in doc ? makeDoc(doc, x, rowY + 120 + index * 228) : makeInvalid(doc, x, rowY + 120 + index * 228)));
        rowHeight = Math.max(rowHeight, 120 + docs.length * 228);
      }
      rowY += rowHeight + 40;
    }
  } else {
    let offsetY = 24;
    documents.forEach((doc, index) => {
      if (doc.kind === 'ia') {
        const items = doc.projection.kind === 'ia' ? doc.projection.nodes : [];
        const children = new Map<string | null, typeof items>();
        for (const item of items) { const siblings = children.get(item.parent_id); if (siblings) siblings.push(item); else children.set(item.parent_id, [item]); }
        const budget = Math.max(0, MAX_MAP_NODES - nodes.length - 1);
        const positions = new Map<string, number>();
        const visited = new Set<string>();
        const stack = (children.get(null) ?? []).slice().reverse().map(item => ({ item, depth: 0, exit: false }));
        let row = 0, emitted = 0;
        while (stack.length) {
          const current = stack.pop()!, { item, depth } = current;
          if (!current.exit) {
            if (visited.has(item.id)) continue;
            if (depth > MAX_MAP_DEPTH || visited.size >= budget) { truncated = true; continue; }
            visited.add(item.id);
            stack.push({ ...current, exit: true });
            const descendants = children.get(item.id) ?? [];
            for (let index = descendants.length - 1; index >= 0; index--) stack.push({ item: descendants[index], depth: depth + 1, exit: false });
          } else {
            const descendants = children.get(item.id) ?? [];
            const ys = descendants.map(child => positions.get(child.id)).filter((y): y is number => y !== undefined);
            const y = ys.length ? (ys[0] + ys.at(-1)!) / 2 : offsetY + row++ * 154;
            positions.set(item.id, y); emitted++;
            addNode({ key: nodeKey(doc.id, item.id), documentId: doc.id, elementId: item.id, kind: 'ia', x: 370 + depth * 330, y, width: 264, height: 116, title: item.label, summary: item.screen_id, eyebrow: item.id, items: descendants.length ? [`하위 항목 ${descendants.length}`] : ['화면 연결'] });
            edges.push({ from: item.parent_id ? nodeKey(doc.id, item.parent_id) : nodeKey(doc.id), to: nodeKey(doc.id, item.id), label: item.parent_id ? 'parent_id' : 'nodes', hierarchy: true });
          }
        }
        if (emitted < items.length) truncated = true;
        const roots = (children.get(null) ?? []).map(item => positions.get(item.id)).filter((y): y is number => y !== undefined);
        addNode(makeDoc(doc, 24, roots.length ? (roots[0] + roots.at(-1)!) / 2 : offsetY));
        offsetY += Math.max(row * 154, 240) + 100;
      } else if (doc.kind === 'architecture' && doc.projection.kind === 'architecture') {
        addNode(makeDoc(doc, 24, offsetY));
        doc.projection.components.slice(0, Math.max(0, MAX_MAP_NODES - nodes.length)).forEach((component, i) => addNode({ key: nodeKey(doc.id, component.id), documentId: doc.id, elementId: component.id, kind: 'architecture', x: 370 + (i % 3) * 330, y: offsetY + Math.floor(i / 3) * 180, width: 264, height: 136, title: component.title, summary: component.responsibility, eyebrow: component.id, items: [] }));
        const rendered = new Set(nodes.filter(node => node.documentId === doc.id).map(node => node.elementId));
        if (rendered.size - 1 < doc.projection.components.length) truncated = true;
        const connectionBudget = Math.max(0, MAX_MAP_EDGES - edges.length);
        if (doc.projection.connections.length > connectionBudget) truncated = true;
        for (const connection of doc.projection.connections.slice(0, connectionBudget)) if (rendered.has(connection.from) && rendered.has(connection.to)) edges.push({ from: nodeKey(doc.id, connection.from), to: nodeKey(doc.id, connection.to), label: connection.protocol, hierarchy: false });
        offsetY += Math.max(240, Math.ceil(doc.projection.components.length / 3) * 180) + 100;
      } else addNode(makeDoc(doc, 24 + (index % 3) * 340, 24 + Math.floor(index / 3) * 250));
    });
    const invalidY = nodes.length ? Math.max(...nodes.map(node => node.y + node.height)) + 64 : 24;
    invalidDocuments.forEach((doc, index) => addNode(makeInvalid(doc, 24 + (index % 3) * 340, invalidY + Math.floor(index / 3) * 250)));
  }
  const keys = new Set(nodes.map(node => node.key));
  return { nodes, edges: edges.filter(edge => keys.has(edge.from) && keys.has(edge.to)), truncated, width: Math.max(600, ...nodes.map(node => node.x + node.width + 40)), height: Math.max(400, ...nodes.map(node => node.y + node.height + 40)) };
}
export interface Navigation { kind: DocumentKind | 'all'; documentId: string | null; elementId: string | null; changeId?: string }
export function parseNavigation(hash: string): Navigation {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const value = params.get('tab');
  return { kind: DOCUMENT_KINDS.includes(value as DocumentKind) ? value as DocumentKind : 'all', documentId: params.get('doc'), elementId: params.get('item'), ...(params.get('change') ? { changeId: params.get('change')! } : {}) };
}
export function navigationHash(navigation: Navigation): string {
  const params = new URLSearchParams({ tab: navigation.kind });
  if (navigation.documentId) params.set('doc', navigation.documentId);
  if (navigation.elementId) params.set('item', navigation.elementId);
  if (navigation.changeId) params.set('change', navigation.changeId);
  return '#' + params.toString();
}
