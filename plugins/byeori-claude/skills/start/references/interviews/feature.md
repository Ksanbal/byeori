# Feature rules and acceptance

Load this guide only for a relevant feature decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

What rule distinguishes valid from invalid behavior? What given/when/then example would prove the outcome?

Schema fields: actors; rules{id,text}; acceptance_criteria{id,given,when,then}; common planning fields.

Link the supporting scenario explicitly; reconcile screen actions, entity constraints and API validation with the same rule. Do not promote a reviewer question into a new requirement without an answer.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: FEAT-MSG-001
kind: feature
title: 메시지 전송
summary: 합성 이용자가 담당 직원에게 텍스트 메시지를 전송한다.
aliases:
- 메시지 보내기
- 채팅
- 담당자 연락
- 상담 메시지
relations:
- type: supports
  target: SCN-MSG-001
open_questions: []
actors:
- ACT-WORKER-001
rules:
- id: RULE-TEXT
  text: 빈 메시지는 전송할 수 없다.
acceptance_criteria:
- id: AC-SEND
  given: 내용을 작성한 상태
  when: 전송을 선택함
  then: 대화에 메시지가 추가됨
```
