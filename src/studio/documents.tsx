import type { ReactNode } from 'react';
import type { DocumentProjection, DocumentView, JsonValue } from '../contracts';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { DataDiagram } from '@/visualizations/DataDiagram';

export const kindNames = { prd: '제품 요구사항', actor: '역할과 권한', scenario: '시나리오', feature: '기능', ia: '정보 구조', screen: '화면', entity: '데이터 모델', openapi: 'OpenAPI', architecture: '아키텍처' };
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>;
}
export function Rows({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">미기록</p>;
  return <Table><TableHeader><TableRow>{headings.map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={index}>{row.map((cell, column) => <TableCell key={column}><div className="whitespace-pre-wrap break-words">{cell}</div></TableCell>)}</TableRow>)}</TableBody></Table>;
}
function List({ values }: { values: string[] }) {
  return values.length ? <ul className="list-inside list-disc whitespace-pre-wrap break-words">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="text-sm text-muted-foreground">미기록</p>;
}
/** Recursive definition lists preserve all OpenAPI standard/extension content as escaped text. */
export function ValueTree({ value }: { value: JsonValue }) {
  if (value === null) return <span>null</span>;
  if (Array.isArray(value)) return value.length ? <ol className="flex list-inside list-decimal flex-col gap-3">{value.map((item, index) => <li key={index}><ValueTree value={item} /></li>)}</ol> : <span>[]</span>;
  if (typeof value === 'object') return Object.keys(value).length ? <dl className="flex min-w-0 flex-col gap-3">{Object.entries(value).map(([key, item]) => <div key={key} className="min-w-0 border-l pl-4"><dt className="break-words font-medium">{key}</dt><dd className="min-w-0 whitespace-pre-wrap break-words"><ValueTree value={item} /></dd></div>)}</dl> : <span>{'{}'}</span>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}
export function DocumentBody({ view, onNavigate, knownIds }: { view: DocumentView; onNavigate: (id: string) => void; knownIds: string[] }) {
  const p = view.projection;
  const ref = (id: string) => knownIds.includes(id) ? <Button variant="link" onClick={() => onNavigate(id)}>{id}</Button> : id;
  const refs = (ids: string[]) => ids.length ? <ul>{ids.map(id => <li key={id}>{ref(id)}</li>)}</ul> : '미기록';
  let body: ReactNode = null;
  switch (p.kind) {
    case 'prd': body = <><Section title="목적"><p>{p.purpose}</p></Section><Section title="목표"><Rows headings={['ID', '내용']} rows={p.goals.map(item => [item.id, item.text])} /></Section><Section title="포함 범위"><List values={p.in_scope} /></Section><Section title="제외 범위"><List values={p.out_of_scope} /></Section><Section title="제약"><List values={p.constraints} /></Section></>; break;
    case 'actor': body = <><Section title="책임"><List values={p.responsibilities} /></Section><Section title="권한"><Rows headings={['행위', '허용 범위']} rows={p.permissions.map(item => [item.action, item.scope])} /></Section></>; break;
    case 'scenario': body = <><Section title="참여자">{refs(p.actors)}</Section><Section title="사전 조건"><List values={p.preconditions} /></Section><Section title="단계"><Rows headings={['ID', '행위자', '행동', '결과']} rows={p.steps.map(item => [item.id, ref(item.actor), item.action, item.result])} /></Section><Section title="최종 결과"><List values={p.outcomes} /></Section></>; break;
    case 'feature': body = <><Section title="참여자">{refs(p.actors)}</Section><Section title="규칙"><Rows headings={['ID', '내용']} rows={p.rules.map(item => [item.id, item.text])} /></Section><Section title="인수 조건"><Rows headings={['ID', '조건', '행동', '기대 결과']} rows={p.acceptance_criteria.map(item => [item.id, item.given, item.when, item.then])} /></Section></>; break;
    case 'ia': body = <Section title="탐색 구조"><Rows headings={['ID', '이름', '화면', '상위 노드']} rows={p.nodes.map(item => [item.id, item.label, ref(item.screen_id), item.parent_id ?? '최상위'])} /></Section>; break;
    case 'screen': body = <><Section title="화면 구성"><Rows headings={['ID', '유형', '이름', '동작']} rows={p.components.map(item => [item.id, item.type, item.label, <List values={item.actions} />])} /></Section><Section title="화면 상태"><Rows headings={['ID', '설명']} rows={p.states.map(item => [item.id, item.description])} /></Section></>; break;
    case 'entity': body = <><Section title="필드"><Rows headings={['ID', '이름', '자료형', 'null 허용']} rows={p.fields.map(item => [item.id, item.name, item.type, item.nullable ? '허용 (true)' : '불허 (false)'])} /></Section><Section title="기본 키"><List values={p.primary_key} /></Section><Section title="제약"><List values={p.constraints} /></Section></>; break;
    case 'architecture': body = <><Section title="구성 요소"><Rows headings={['ID', '이름', '책임']} rows={p.components.map(item => [item.id, item.title, item.responsibility])} /></Section><Section title="연결"><Rows headings={['ID', '출발', '도착', '프로토콜']} rows={p.connections.map(item => [item.id, item.from, item.to, item.protocol])} /></Section><Section title="설계 결정"><Rows headings={['ID', '내용']} rows={p.decisions.map(item => [item.id, item.text])} /></Section></>; break;
    case 'openapi': body = <><Section title="API 작업"><Rows headings={['Operation ID', '메서드', '경로', '포인터', '관련 기능']} rows={p.operations.map(item => [item.operation_id, item.method, item.path, item.pointer, refs(item.feature_ids)])} /></Section><Section title="OpenAPI 전체 명세"><ValueTree value={p.document} /></Section></>; break;
    default: p satisfies never;
  }
  return <article aria-label={`${kindNames[p.kind]} 본문`} className="flex min-w-0 flex-col gap-8">
    <Section title="개요"><p className="whitespace-pre-wrap break-words">{p.summary || '미기록'}</p><Rows headings={['ID', '종류', '제목', '스키마']} rows={[[p.id, p.kind, p.title, p.kind === 'openapi' ? p.document.openapi : p.schema_version]]} /></Section>
    {isDiagram(p) && <DataDiagram document={p} />}
    {body}
    <Section title="별칭"><List values={p.aliases} /></Section>
    <Section title="관계"><Rows headings={['관계', '대상']} rows={p.relations.map(item => [item.type, ref(item.target)])} /></Section>
    <Section title="미결 질문"><Rows headings={['ID', '질문', '차단 여부']} rows={p.open_questions.map(item => [item.id, item.text, item.blocking ? '차단 (true)' : '비차단 (false)'])} /></Section>
    <Collapsible><CollapsibleTrigger asChild><Button variant="outline">원본 YAML 보기</Button></CollapsibleTrigger><CollapsibleContent><pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-sm">{view.raw}</pre></CollapsibleContent></Collapsible>
  </article>;
}
function isDiagram(p: DocumentProjection): p is Extract<DocumentProjection, {kind: 'scenario' | 'ia' | 'screen' | 'entity' | 'architecture'}> {
  return ['scenario', 'ia', 'screen', 'entity', 'architecture'].includes(p.kind);
}
