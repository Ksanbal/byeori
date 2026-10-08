# Screen actions and states

Load this guide only for a relevant screen decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

Which action moves the user toward the outcome? What does the user see while empty, loading, invalid or denied?

Schema fields: components{id,type,label,actions}; states{id,description}; common planning fields.

Use stable component/state IDs and explicit renders relations to features. Cross-adjust IA, scenario outcomes, validation rules and accessibility needs instead of inventing backend behavior.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: SCR-MSG-001
kind: screen
title: 상담 채팅 화면
summary: 메시지 목록과 작성 입력창을 제공한다.
aliases:
- 채팅 화면
- 메시지 입력창
- 대화 화면
relations:
- type: renders
  target: FEAT-MSG-001
open_questions: []
components:
- id: COMP-LIST
  type: message-list
  label: 대화 목록
  actions: []
- id: COMP-INPUT
  type: text-input
  label: 메시지 작성
  actions:
  - send
states:
- id: STATE-EMPTY
  description: 아직 메시지가 없음
- id: STATE-READY
  description: 메시지를 작성할 수 있음
```
