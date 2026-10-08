# Product purpose and version scope

Load this guide only for a relevant prd decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

What problem and outcome define this version? Which capabilities are explicitly outside it?

Schema fields: purpose; goals{id,text}; in_scope/out_of_scope/constraints; common fields schema_version,id,kind,title,summary,aliases,relations,open_questions{id,text,blocking}.

Adjust feature/scenario goals and scope together; keep guesses in workflow.assumptions rather than declaring them confirmed.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: PRD-DEMO-001
kind: prd
title: 합성 상담 서비스
summary: fixture 전용 상담 메시지 흐름이다. 실제 복지 대상자 데이터가 아니다.
aliases:
- 제품 개요
- 목표
- 기획
relations: []
open_questions: []
purpose: 직원과 이용자 간 상담 요청을 놓치지 않는다.
goals:
- id: GOAL-001
  text: 메시지 요청에서 답변까지의 흐름을 명확히 정의한다.
in_scope:
- 텍스트 메시지
- 권한 구분
out_of_scope:
- 실제 개인정보 저장
- 결제
constraints:
- 합성 데이터만 사용
```
