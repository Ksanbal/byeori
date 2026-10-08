# System boundaries and decisions

Load this guide only for a relevant architecture decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

Which components own each responsibility? Which confirmed constraint drives the connection or technology decision?

Schema fields: components{id,title,responsibility}; connections{id,from,to,protocol}; decisions{id,text}; common planning fields.

Connection endpoints are component IDs in this document. Reconcile API/data boundaries and feature constraints; preserve proposed decisions as assumptions or blocking questions until confirmed.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: ARCH-DEMO-001
kind: architecture
title: 상담 시스템 구조
summary: 브라우저와 로컬 API를 분리한 합성 시스템 구조다.
aliases:
- 시스템 구조
- 서버 구성
- 아키텍처
relations:
- type: related_to
  target: FEAT-MSG-001
open_questions: []
components:
- id: COMP-WEB
  title: Web
  responsibility: 메시지 UI
- id: COMP-API
  title: API
  responsibility: 메시지 저장
connections:
- id: CONN-WEB-API
  from: COMP-WEB
  to: COMP-API
  protocol: HTTP
decisions:
- id: DEC-001
  text: 합성 fixture의 기능 경계만 표현한다.
```
