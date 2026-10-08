import { useId, useState } from 'react';
import type { DocumentProjection } from '../../contracts';
import { Button } from '@/components/ui/button';

type DiagramDocument = Extract<DocumentProjection, {kind: 'scenario' | 'ia' | 'screen' | 'entity' | 'architecture'}>;
interface Node { id: string; label: string }
interface Edge { from: string; to: string; label: string }
export function diagramData(document: DiagramDocument): { nodes: Node[]; edges: Edge[] } {
  switch (document.kind) {
    case 'scenario': return { nodes: document.steps.map(step => ({id: step.id, label: step.action})), edges: document.steps.slice(1).map((step, index) => ({from: document.steps[index].id, to: step.id, label: '다음 단계'})) };
    case 'ia': return { nodes: document.nodes.map(node => ({id: node.id, label: node.label})), edges: document.nodes.filter(node => node.parent_id).map(node => ({from: node.parent_id!, to: node.id, label: '하위'})) };
    case 'screen': return { nodes: document.components.map(component => ({id: component.id, label: component.label})), edges: [] };
    case 'entity': return { nodes: document.fields.map(field => ({id: field.id, label: `${field.name}: ${field.type}${field.nullable ? ' (null 허용)' : ''}`})), edges: [] };
    case 'architecture': return { nodes: document.components.map(component => ({id: component.id, label: component.title})), edges: document.connections.map(connection => ({from: connection.from, to: connection.to, label: connection.protocol})) };
  }
}
export function sketchOffset(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 5) - 2;
}
export function DataDiagram({ document }: { document: DiagramDocument }) {
  const [zoom, setZoom] = useState(1);
  const id = useId();
  const { nodes, edges } = diagramData(document);
  const width = 640;
  const height = Math.max(180, nodes.length * 140);
  const position = (node: Node) => ({ x: 80 + sketchOffset(document.id + node.id + width), y: 40 + nodes.indexOf(node) * 140 });
  return <section className="flex min-w-0 flex-col gap-3" aria-label="데이터 그림">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">구조 그림</h2><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={zoom >= 2} onClick={() => setZoom(value => value + 0.25)}>확대</Button><Button variant="outline" size="sm" disabled={zoom <= 0.75} onClick={() => setZoom(value => value - 0.25)}>축소</Button><Button variant="ghost" size="sm" onClick={() => setZoom(1)}>초기화</Button><span className="text-sm text-muted-foreground">{Math.round(zoom * 100)}%</span></div></div>
    <p className="text-sm text-muted-foreground">원본 ID를 기준으로 배치했습니다. 전체 내용은 아래 표에서도 읽을 수 있습니다.</p>
    <div className="overflow-auto rounded-md border bg-muted/30" tabIndex={0} aria-label="그림 스크롤 영역">
      <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
        <title id={`${id}-title`}>{`${document.title} 구조`}</title><desc id={`${id}-desc`}>{nodes.map(node => `${node.id}: ${node.label}`).join('; ')}. {edges.map(edge => `${edge.from} → ${edge.to}: ${edge.label}`).join('; ')}</desc>
        {edges.map((edge, index) => {
          const from = nodes.find(node => node.id === edge.from); const to = nodes.find(node => node.id === edge.to);
          if (!from || !to) return null;
          const a = position(from); const b = position(to);
          return <g key={index}><path d={`M ${a.x + 450} ${a.y + 40} L 580 ${a.y + 40} L 580 ${b.y + 40} L ${b.x + 450} ${b.y + 40}`} fill="none" stroke="currentColor" /><text x={585} y={(a.y + b.y) / 2 + 32} className="fill-foreground text-xs">{edge.label}</text></g>;
        })}
        {nodes.map(node => {
          const {x, y} = position(node); const shift = sketchOffset(JSON.stringify(document) + node.id + width);
          return <g key={node.id}><path d={`M ${x} ${y} L ${x + 450} ${y + shift} L ${x + 450 + shift} ${y + 88} L ${x - shift} ${y + 88} Z`} className="fill-background stroke-foreground" /><text x={x + 16} y={y + 28} className="fill-muted-foreground text-xs">{node.id}</text><text x={x + 16} y={y + 57} className="fill-foreground text-sm">{node.label.length > 36 ? node.label.slice(0, 36) + '…' : node.label}</text></g>;
        })}
      </svg>
    </div>
  </section>;
}
