# Data shape and invariants

Load this guide only for a relevant entity decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

Which fields and keys make the record identifiable? Which nullability, retention or uniqueness rule is confirmed?

Schema fields: fields{id,name,type,nullable}; primary_key; constraints; common planning fields.

A primary_key entry names exactly one field name or stable ID. Coordinate feature rules, actor access scope and API schemas; do not put real personal data into examples.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: ENT-MSG-001
kind: entity
title: Message 데이터
summary: 메시지 식별자와 본문을 저장하는 합성 데이터 모델이다.
aliases:
- 메시지 테이블
- DB 필드
- ERD
relations:
- type: stores
  target: FEAT-MSG-001
open_questions: []
fields:
- id: FLD-ID
  name: id
  type: string
  nullable: false
- id: FLD-BODY
  name: body
  type: string
  nullable: false
primary_key:
- id
constraints:
- body는 비어 있지 않음
```
