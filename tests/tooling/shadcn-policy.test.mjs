import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ESLint} from 'eslint';
const eslint=new ESLint();
const probe=path.resolve('src/studio/features/__design_policy_probe__.tsx');
const prefix='import { Button } from "@/components/ui/button";\n';
const rules=['no-restyle','no-raw-colors','no-arbitrary-values','no-inline-styles','no-unknown-classes','require-static-classes'];
const level=value=>Array.isArray(value)?value[0]:value;
const isError=value=>level(value)===2||level(value)==='error';
async function lint(source){
 const results=await eslint.lintText(source,{filePath:probe});
 assert.equal(results.length,1,'Probe must be linted, not ignored');
 const r=results[0];
 assert.equal(r.fatalErrorCount,0,'A parser failure is not policy enforcement');
 assert.ok(!r.messages.some(m=>m.message.toLowerCase().includes('ignored')),'Probe must be in the lint scope');
 return r.messages;
}
test('effective Studio config actually enables all required shadcn rules',async()=>{
 const c=await eslint.calculateConfigForFile(probe);assert.ok(c);
 for(const rule of rules)assert.ok(isError(c.rules[`shadcn/${rule}`]),`Missing error rule: ${rule}`);
});
test('UI implementation only exempts no-restyle, not other policies',async()=>{
 const c=await eslint.calculateConfigForFile(path.resolve('src/studio/components/ui/button.tsx'));
 assert.ok([0,'off'].includes(level(c.rules['shadcn/no-restyle'])));
 for(const rule of rules.filter(r=>r!=='no-restyle'))assert.ok(isError(c.rules[`shadcn/${rule}`]),`Excessively broad exception: ${rule}`);
});
for(const [rule,source] of [
 ['no-restyle',prefix+'export function Probe(){ return <Button className="p-4">Save</Button>; }'],
 ['no-raw-colors','export function Probe(){ return <div className="bg-pink-500">Text</div>; }'],
 ['no-arbitrary-values','export function Probe(){ return <div className="p-[13px]">Text</div>; }'],
 ['no-inline-styles','export function Probe(){ return <div style={{padding:13}}>Text</div>; }'],
 ['no-unknown-classes','export function Probe(){ return <div className="rounded-huge">Text</div>; }'],
 ['require-static-classes',prefix+'export function Probe({tone}:{tone:string}){return <Button className={`bg-${tone}`}>Save</Button>;}'],
])test(`intentional violation is detected: ${rule}`,async()=>{
 const messages=await lint(source);assert.ok(messages.some(m=>m.ruleId===`shadcn/${rule}`),JSON.stringify(messages));
});
test('normal variant and theme-token composition has no shadcn violations',async()=>{
 const messages=await lint(prefix+'export function Probe(){return <div className="flex flex-col gap-4 bg-background text-foreground"><Button size="sm" variant="outline">Save</Button></div>;}');
 assert.deepEqual(messages.filter(m=>m.ruleId?.startsWith('shadcn/')),[]);
});
test('UI implementations still reject raw colors and allow normal style definitions', async () => {
 const filePath = path.resolve('src/studio/components/ui/__policy_probe__.tsx');
 const [bad] = await eslint.lintText('export function Probe(){return <div className="bg-pink-500"/>;}', {filePath});
 assert.ok(bad.messages.some(m=>m.ruleId==='shadcn/no-raw-colors'));
 const [good] = await eslint.lintText('export function Probe(){return <button className="px-4 py-2 bg-primary text-primary-foreground"/>;}', {filePath});
 assert.deepEqual(good.messages, []);
});
test('visualization coordinates use SVG attributes without policy exemptions', async () => {
 const filePath = path.resolve('src/studio/visualizations/__policy_probe__.tsx');
 const [good] = await eslint.lintText('export function Probe({x}:{x:number}){return <svg><circle cx={x} cy={4} r={3} fill="currentColor"/></svg>;}', {filePath});
 assert.deepEqual(good.messages, []);
 const [bad] = await eslint.lintText('export function Probe(){return <svg style={{padding:13}}/>;}', {filePath});
 assert.ok(bad.messages.some(m=>m.ruleId==='shadcn/no-inline-styles'));
});
