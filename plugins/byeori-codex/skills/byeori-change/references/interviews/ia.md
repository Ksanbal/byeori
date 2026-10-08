# Navigation and screen hierarchy

Load this guide only for a relevant ia decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

Where should a user find the target screen? Which parent relationship or navigation state changes access?

Schema fields: nodes{id,label,screen_id,parent_id}; common planning fields.

screen_id references a screen document. Parent IDs reference nodes in the same IA and must not cycle; root parent_id is null. Coordinate screen availability and role permissions.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: IA-DEMO-001
kind: ia
title: 상담 메뉴 구조
summary: 상담 화면으로 이동하는 메뉴 계층이다.
aliases:
- 메뉴 구조
- 사이트맵
- 화면 목록
relations:
- type: related_to
  target: SCR-MSG-001
open_questions: []
nodes:
- id: NAV-CHAT
  label: 상담
  screen_id: SCR-MSG-001
  parent_id: null
```
