import { useEffect, useState } from 'react';
import type { DocumentDelta, DocumentView, GetRequest, JsonValue, ReviewRound, ReviewResults } from '../../contracts';
import { post } from '@/lib/api';
import { bindingKey, reviewBinding } from '@/lib/review-session';
import { semanticDiff } from '@/lib/semantic-diff';
import { DocumentBody, Rows, Section, ValueTree } from '@/documents';
import { Failure, History, Details, type Load } from '@/panels';
import type { StudioState } from '../../contracts';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';

export interface FrozenPair {before?: DocumentView; after?: DocumentView}
export function useFrozenDocuments(review: ReviewResults, retry: number) {
  const key = JSON.stringify([reviewBinding(review), retry, review.round.manifest.deltas]);
  const [loaded, setLoaded] = useState<Load<{documents: Record<string, FrozenPair>; ready: boolean}>>({key: ''});
  useEffect(() => {
    const [binding, , deltas] = JSON.parse(key) as [ReturnType<typeof reviewBinding>, number, DocumentDelta[]];
    const abort = new AbortController();
    void (async () => {
      const documents: Record<string, FrozenPair> = Object.create(null);
      try {
        // Exact frozen snapshots only; never read current drafts for a reviewed title/body.
        for (const delta of deltas) {
          const pair: FrozenPair = {};
          for (const side of ['before', 'after'] as const) if (delta[side]) pair[side] = await post<DocumentView>('/api/document', {object_id: delta.object_id, revision: {change_id: binding.change_id, round: binding.round, manifest_hash: binding.manifest_hash, side}}, abort.signal);
          documents[delta.object_id] = pair;
          if (!abort.signal.aborted) setLoaded({key, data: {documents: {...documents}, ready: false}});
        }
        if (!abort.signal.aborted) setLoaded({key, data: {documents, ready: true}});
      } catch (error) {if (!abort.signal.aborted) setLoaded({key, error, data: {documents, ready: false}});}
    })();
    return () => abort.abort();
  }, [key]);
  return loaded.key === key ? loaded : {key};
}
export const operationNames = {add: '추가', modify: '수정', delete: '삭제', unchanged: '변경 없음', move: '경로 이동'};
export function permissionChanges(documents: Record<string, FrozenPair>): {id: string; path: string; before: JsonValue | undefined; after: JsonValue | undefined}[] {
  return Object.entries(documents).flatMap(([id, pair]) => semanticDiff(pair.before?.content as JsonValue | undefined, pair.after?.content as JsonValue | undefined).filter(row => row.operation !== 'unchanged' && /permission|security|authoriz|권한/i.test(row.path)).map(row => ({id, ...row})));
}
export function FrozenDiff({id, review, pair, error, retry, navigate, state, onSnapshot}: {id: string; review: ReviewResults; pair?: FrozenPair; error?: unknown; retry: () => void; navigate: (id: string) => void; state: StudioState; onSnapshot: (request: GetRequest, round?: ReviewRound) => void}) {
  const [unchanged, setUnchanged] = useState(false);
  const delta = review.round.manifest.deltas.find(delta => delta.object_id === id);
  const view = pair?.after ?? pair?.before;
  const rows = pair ? semanticDiff(pair.before?.content as JsonValue | undefined, pair.after?.content as JsonValue | undefined) : [];
  return <div className="flex min-w-0 flex-col gap-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{view?.projection.title ?? id}</h1><p className="mt-2 text-sm text-muted-foreground">{id} · 고정본 {review.round.manifest.round}차</p></div><div className="flex flex-wrap gap-2"><History key={bindingKey(reviewBinding(review)) + id} objectId={id} onSnapshot={onSnapshot} /><Details view={view} state={state} /></div></div>{delta && <div className="flex flex-wrap gap-2"><Badge variant={delta.operation === 'delete' ? 'destructive' : 'outline'}>{operationNames[delta.operation]}</Badge><p className="break-words text-sm">{delta.before?.path}{delta.operation === 'move' ? ' → ' + delta.after.path : !delta.before ? delta.after?.path : ''}</p></div>}
    {error ? <Failure error={error} retry={retry} /> : !pair ? <p role="status">고정 문서를 불러오는 중입니다.</p> : <>
      {pair.before && pair.after && <Section title="의미 변경 비교"><Field orientation="horizontal"><Checkbox id="show-unchanged" checked={unchanged} onCheckedChange={value => setUnchanged(value === true)} /><FieldLabel htmlFor="show-unchanged">변경 없는 필드도 보기</FieldLabel></Field><Rows headings={['필드', '변경', '변경 전', '변경 후']} rows={rows.filter(row => unchanged || row.operation !== 'unchanged').map(row => [row.path, operationNames[row.operation], row.before === undefined ? '없음' : <ValueTree value={row.before} />, row.after === undefined ? '없음' : <ValueTree value={row.after} />])} /></Section>}
      <div className="grid min-w-0 gap-8 xl:grid-cols-2">{(['before', 'after'] as const).map(side => pair[side] && <section key={side} aria-label={side === 'before' ? '변경 전 고정 문서' : '변경 후 고정 문서'} className="min-w-0"><h2 className="mb-4 text-lg font-semibold">{side === 'before' ? '변경 전' : '변경 후'}</h2><DocumentBody view={pair[side]!} onNavigate={navigate} knownIds={review.round.manifest.deltas.map(delta => delta.object_id)} /></section>)}</div>
    </>}
  </div>;
}
