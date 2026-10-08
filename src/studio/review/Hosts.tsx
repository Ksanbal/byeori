import { useEffect, useState } from 'react';
import type { HostCapability, HostId } from '../../contracts';
import { getHosts, post } from '@/lib/api';
import { ErrorText } from '@/panels';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';

export function Hosts() {
  const [hosts, setHosts] = useState<HostCapability[]>(); const [error, setError] = useState<unknown>();
  const [host, setHost] = useState<HostId>('codex'); const [reason, setReason] = useState(''); const [acknowledged, setAcknowledged] = useState(false); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  useEffect(() => {const abort = new AbortController(); getHosts(abort.signal).then(setHosts).catch(error => {if (!abort.signal.aborted) setError(error);}); return () => abort.abort();}, [refresh]);
  const choose = async () => {
    if (busy || !acknowledged || !reason.trim()) return;
    setBusy(true); setError(undefined);
    try {const selected = await post<HostCapability>('/api/advisory', {host, reason}); setHosts(previous => previous?.map(item => item.host === host ? selected : item)); setAcknowledged(false);}
    catch (error) {setError(error);} finally {setBusy(false);}
  };
  return <Collapsible><CollapsibleTrigger asChild><Button variant="outline" size="sm">호스트 보호 상태</Button></CollapsibleTrigger><CollapsibleContent className="mt-4"><div className="flex flex-col gap-4"><Alert><AlertTitle>현재 실행의 강제 보호를 확인해 주세요</AlertTitle><AlertDescription>저장된 관측은 현재 호스트 실행의 강제 보호를 보장하지 않습니다. 권고 모드에서는 도구 쓰기를 강제로 막지 못합니다.</AlertDescription></Alert>{Boolean(error) && <Alert variant="destructive"><AlertTitle>호스트 상태를 확인하지 못했습니다</AlertTitle><AlertDescription><ErrorText error={error} /><Button variant="outline" onClick={() => setRefresh(value => value + 1)}>호스트 상태 다시 확인</Button></AlertDescription></Alert>}{!hosts ? <p role="status">기록된 호스트 관측을 불러오는 중입니다.</p> : hosts.map(item => <section key={item.host}><h3 className="font-semibold">{item.host === 'codex' ? 'Codex' : 'Claude Code'}</h3><p>{item.active ? '기록된 활성 관측 있음 · 현재 실행은 별도 확인 필요' : '현재 강제 보호가 확인되지 않음'}</p><p>{item.mode.type === 'advisory' ? '사람이 권고 모드를 선택함: ' + item.mode.reason : '권고 모드 선택 기록 없음'}</p><p className="text-sm text-muted-foreground">마지막 검사: {item.probed.checked_at ?? '미기록'} · 미보호 도구: {item.coverage.uncovered_tools.join(', ') || '관측 미기록'}</p></section>)}
    <FieldGroup><Field><FieldLabel htmlFor="advisory-host">권고 모드를 선택할 호스트</FieldLabel><Select value={host} disabled={busy} onValueChange={value => {setHost(value as HostId); setAcknowledged(false);}}><SelectTrigger id="advisory-host"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="codex">Codex</SelectItem><SelectItem value="claude">Claude Code</SelectItem></SelectGroup></SelectContent></Select></Field><Field><FieldLabel htmlFor="advisory-reason">권고 모드 선택 이유</FieldLabel><Textarea id="advisory-reason" disabled={busy} value={reason} onChange={event => setReason(event.target.value)} /></Field><Field orientation="horizontal"><Checkbox id="advisory-acknowledgment" disabled={busy} checked={acknowledged} onCheckedChange={value => setAcknowledged(value === true)} /><FieldLabel htmlFor="advisory-acknowledgment">강제 보호가 없다는 한계를 이해하고 권고 모드를 선택합니다</FieldLabel></Field><Button variant="outline" disabled={busy || !acknowledged || !reason.trim()} onClick={() => {void choose();}}>권고 모드 선택</Button></FieldGroup><p className="text-sm text-muted-foreground">이 선택은 기획 승인이나 구현 허용을 대신하지 않습니다.</p>
  </div></CollapsibleContent></Collapsible>;
}
