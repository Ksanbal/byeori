import type { ReviewFeedback, ReviewResults } from '../../contracts';
import { Rows, Section, ValueTree } from '@/documents';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel } from '@/components/ui/field';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { decisionNames } from './Comments';
import { permissionChanges, type FrozenPair } from './FrozenDiff';

export function ScopeSummary({review}: {review: ReviewResults}) {
  const scope = review.round.manifest.metadata.implementation_scope;
  return <Section title="고정된 구현 허용 범위"><Rows headings={['경로', '범위']} rows={scope.allowlist.map(item => [item.path, item.match === 'file' ? '이 파일만' : '이 디렉터리 하위'])} /><p className="break-words">관련 문서: {scope.related_object_ids.join(', ') || '미기록'}</p><p>검증 계획: {scope.validation_plan.length ? scope.validation_plan.join(' · ') : '미기록'}</p></Section>;
}
export function Confirmation({review, feedback, documents, open, onOpen, onChange, submit, disabled, busy}: {review: ReviewResults; feedback: ReviewFeedback; documents: Record<string, FrozenPair>; open: boolean; onOpen: (open: boolean) => void; onChange: (feedback: ReviewFeedback) => void; submit: () => void; disabled: boolean; busy: boolean}) {
  const manifest = review.round.manifest;
  const deletions = manifest.deltas.filter(delta => delta.operation === 'delete');
  const permissions = permissionChanges(documents);
  const unresolved = feedback.items.filter(item => item.decision !== 'approve');
  const blocking = feedback.items.flatMap(item => item.comments.filter(comment => comment.blocking));
  const canAllow = manifest.metadata.implementation_scope.allowlist.length > 0 && unresolved.length === 0 && blocking.length === 0;
  return <Dialog open={open} onOpenChange={value => {if (!busy) onOpen(value);}}><DialogTrigger asChild><Button disabled={disabled}>리뷰 제출</Button></DialogTrigger><DialogContent className="max-h-screen overflow-y-auto" showCloseButton={!busy}><DialogHeader><DialogTitle>최종 리뷰 확인</DialogTitle><DialogDescription>{manifest.metadata.title} · 고정 {manifest.round}차. 임시 저장은 승인으로 사용되지 않습니다.</DialogDescription></DialogHeader>
    <Section title="변경 목적과 이유"><p>요청: {manifest.metadata.request}</p><p>이유: {manifest.metadata.reason}</p><p>{manifest.metadata.type === 'implementation_only' ? '기획 변경 없이 구현 범위만 검토합니다.' : '기획 문서 변경을 검토합니다.'}</p></Section>
    <Section title="모든 항목의 판단"><Rows headings={['항목', '판단', '차단 댓글']} rows={feedback.items.map(item => {const object = manifest.items.find(entry => entry.item_id === item.item_id)!; const id = object.type === 'document' ? object.object_id : 'scope:implementation'; return [id === 'scope:implementation' ? '구현 범위' : (documents[id]?.after ?? documents[id]?.before)?.projection.title ?? id, decisionNames[item.decision], item.comments.filter(comment => comment.blocking).map(comment => <p key={comment.id}>{comment.body}</p>)];})} /></Section>
    {(unresolved.length > 0 || blocking.length > 0) && <Alert><AlertTitle>완료되지 않은 판단이 있습니다</AlertTitle><AlertDescription><p>미승인 {unresolved.length}개 · 차단 댓글 {blocking.length}개. 이 상태로 제출하면 기획 승인과 구현 허용이 성립하지 않습니다.</p></AlertDescription></Alert>}
    <Section title="삭제"><p>{deletions.length ? deletions.map(delta => delta.object_id).join(', ') : '삭제 없음'}</p></Section>
    <Section title="권한과 보호 설정 변화">{permissions.length ? <Rows headings={['문서 · 필드', '변경 전', '변경 후']} rows={permissions.map(change => [change.id + ' · ' + change.path, change.before === undefined ? '없음' : <ValueTree value={change.before} />, change.after === undefined ? '없음' : <ValueTree value={change.after} />])} /> : <p>고정 문서의 권한·보호 설정 필드 변화 없음</p>}</Section>
    <ScopeSummary review={review} />
    <Field orientation="horizontal"><Checkbox id="allow-implementation" disabled={busy || !canAllow} checked={feedback.implementation_authorization.allowed} onCheckedChange={checked => onChange({...feedback, implementation_authorization: checked === true ? {allowed: true, scope_hash: manifest.scope_hash} : {allowed: false, scope_hash: null}})} /><FieldLabel htmlFor="allow-implementation">기획 승인 후 위 범위의 구현도 허용</FieldLabel></Field>
    <p>{feedback.implementation_authorization.allowed ? '표시한 고정 범위에만 구현 허용을 요청합니다. 원본 반영과 구현 완료는 별도입니다.' : '기본값: 기획 판단만 제출 · 구현 허용 안 함'}</p><p className="break-all text-xs text-muted-foreground">고정 범위 식별값: {manifest.scope_hash}</p>
    <DialogFooter><DialogClose asChild><Button variant="outline" disabled={busy}>돌아가서 검토</Button></DialogClose><Button disabled={disabled || busy} onClick={submit}>{busy ? '최종 기록 확인 중' : '이 판단으로 최종 제출'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
