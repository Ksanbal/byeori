import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {post} from '../../src/studio/lib/api';

test('cancelled views wait for server completion and subsequent Core reads stay ordered', async () => {
 const original=globalThis.fetch;const calls:string[]=[];let release:(response:Response)=>void=()=>{throw new Error('The first read did not start');};
 const reply=(data:unknown)=>new Response(JSON.stringify({ok:true,data,diagnostics:[],meta:{schema_version:1,runtime_version:'test',policy_version:'test',canonicalization_version:'test'}}));
 globalThis.fetch=async (input,init)=>{
  if(String(input)==='/api/session')return reply({csrf_token:'synthetic-test-session'});
  const body=JSON.parse(String(init?.body)) as {object_id:string};calls.push(body.object_id);
  if(body.object_id==='first')return new Promise<Response>(resolve=>{release=resolve;});
  return reply({id:body.object_id});
 };
 try {
  const abort=new AbortController();const first=post('/api/document',{object_id:'first'},abort.signal);const rejected=assert.rejects(first,error=>error instanceof Error&&error.name==='AbortError');
  await setImmediate();assert.deepEqual(calls,['first']);abort.abort();
  const second=post<{id:string}>('/api/document',{object_id:'second'});await setImmediate();assert.deepEqual(calls,['first']);
  release(reply({id:'first'}));await rejected;assert.deepEqual(await second,{id:'second'});assert.deepEqual(calls,['first','second']);
 }finally{globalThis.fetch=original;}
});
