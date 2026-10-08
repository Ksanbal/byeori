# User sequence and outcomes

Load this guide only for a relevant scenario decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

What starts the sequence and what observable outcome ends it? What changes when a prerequisite fails?

Schema fields: actors; preconditions; steps{id,actor,action,result}; outcomes; common planning fields.

Every step.actor must be a declared actor ID. Coordinate feature acceptance criteria, screen states and API failure outcomes.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: SCN-MSG-001
kind: scenario
title: 담당 직원에게 상담 메시지 보내기
summary: 이용자가 메시지를 보내면 담당 직원이 확인하고 답변한다.
aliases:
- 메시지 흐름
- 상담 순서
- 유저 플로우
relations: []
open_questions: []
actors:
- ACT-WORKER-001
preconditions:
- 합성 이용자 세션과 담당자가 존재한다.
steps:
- id: STEP-SEND
  actor: ACT-WORKER-001
  action: 합성 테스트용 메시지 작성 후 전송
  result: 메시지가 저장됨
- id: STEP-REPLY
  actor: ACT-WORKER-001
  action: 메시지 확인 후 답변
  result: 답변이 대화에 표시됨
outcomes:
- 상담 대화가 남는다.
```
