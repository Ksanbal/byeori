# Native OpenAPI operation contract

Load this guide only for a relevant openapi decision. Ask a few focused questions, reuse durable answers, and label facts/assumptions/open questions rather than filling unanswered user decisions.

What request and success/error response does the consumer need? Which approved feature and permission justify the operation?

Schema fields: Native OpenAPI 3.1.1: info{title,version,x-byeori-id}; paths and operationId; x-byeori-features feature IDs; requestBody/responses/security as confirmed. No planning wrapper kind/id around OpenAPI.

Every reviewable operation needs a unique operationId. Preserve standard/extension content and use offline pinned supported dialect/local references; do not follow remote schema URLs. Reconcile entity fields, feature validation and actor permissions. Unresolved API questions stay visible in workflow.open_questions; do not claim implementation readiness merely because syntax validates.

The following is a synthetic shape example, not the user's decision, approved source or an implemented system. Replace its IDs/content only from confirmed project context, preserve stable existing IDs, write through change put, and lint the complete related projection before review.

```yaml
openapi: 3.1.1
info:
  title: Synthetic Message API
  version: 0.0.0
  x-byeori-id: API-MSG-001
paths:
  /messages:
    post:
      operationId: sendMessage
      x-byeori-features:
      - FEAT-MSG-001
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                body:
                  type: string
                  minLength: 1
              required:
              - body
              additionalProperties: false
      responses:
        '201':
          description: 합성 메시지 생성 성공
        '400':
          description: 유효하지 않은 메시지
```
