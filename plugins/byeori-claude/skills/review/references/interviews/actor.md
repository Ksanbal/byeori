# Roles and permissions

Load this guide only for a relevant actor decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

Who performs this action, and which records may they access? Which action must this role never perform?

Schema fields: responsibilities; permissions{action,scope}; common planning fields.

Cross-check scenario actors/step actor and feature actors. Labels such as employee are not an authorization rule; ask for the actual scope.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
schema_version: 1
id: ACT-WORKER-001
kind: actor
title: 담당 직원
summary: 담당 범위에 속한 이용자의 상담 메시지를 처리한다.
aliases:
- 복지사
- 상담사
- 직원
- 권한
relations: []
open_questions: []
responsibilities:
- 담당 상담 확인
permissions:
- action: message.read
  scope: assigned_only
- action: message.reply
  scope: assigned_only
```
