# 벼리 빠른 시작

**상태:** 현재 공개 버전은 stable이 아닌 사전 릴리스 `0.1.0-rc.1`입니다. [GitHub Releases](https://github.com/Ksanbal/byeori/releases)에서 asset을 받고, [GitHub Actions](https://github.com/Ksanbal/byeori/actions/workflows/ci.yml)에서 CI를 확인하세요. Claude 인증 모델 사용은 확인되지 않았고, Codex 훅 신뢰 결정은 남아 있어 활성 강제 적용은 확인되지 않았습니다. 자세한 근거는 [검증 기록](verification.md)을 참고하세요.

## 네 단계

1. **호스트 플러그인 설치** — [설치 안내](installation.md)의 호스트별 명령을 사용하세요.
2. **프로젝트 초기화** — Node `>=24.13.0 <25`가 필요합니다. 설치되었거나 압축을 푼 플러그인의 `runtime/cli.mjs` 경로를 확인하고 다음을 실행합니다.

   ```sh
   BYEORI_CLI="/path/to/byeori-plugin/runtime/cli.mjs"
   PROJECT="/path/to/project"
   node "$BYEORI_CLI" init --root "$PROJECT" --json
   node "$BYEORI_CLI" doctor --root "$PROJECT" --json
   node "$BYEORI_CLI" status --root "$PROJECT" --json
   ```

   `init`은 선택한 프로젝트에 관리 대상 계획 안내와 planning/workflow 파일을 만듭니다. 변경 결과를 확인한 뒤 진행하세요. 소비자 프로젝트에는 pnpm이나 개발 의존성이 필요하지 않습니다.

3. **초안 작성과 검토 준비** — Claude Code 스킬은 `/byeori:init`, `/byeori:start`, `/byeori:change`, `/byeori:review`이며 Codex는 `$byeori-init`, `$byeori-start`, `$byeori-change`, `$byeori-review`입니다. 각 스킬로 PRD, actor, scenario, feature, IA, screen, entity, OpenAPI 3.1.1, architecture 문서를 작성하고 검증 후 고정된 검토 회차를 준비합니다.
4. **직접 검토·제출** — Studio를 열어 각 항목, 삭제, 댓글, 선택적 구현 경로 범위를 확인하고 사람이 직접 제출합니다. 저장만으로 승인되지 않습니다. 이후 보조자에게 결과를 다시 읽게 하세요. 계획 승인과 코드 수정 권한은 별개이며, 코드 권한은 검토한 경로에만 적용됩니다.

## 파일과 기록

제품 계획/검토 기록은 프로젝트의 `planning/`에 저장되고 Git으로 관리할 수 있습니다. `.byeori/` 검색 인덱스는 다시 만들 수 있는 캐시입니다. 기록은 전체 대화나 비밀을 저장하기 위한 곳이 아닙니다. [제품 모델](product-model.md)과 [아키텍처](architecture-overview.md)를 참고하세요.

## 업데이트와 제거

호스트 플러그인 업데이트/제거 절차는 [설치 안내](installation.md)를 따르세요. 프로젝트에서 `byeori host remove`를 실행하면 Byeori가 관리하는 안내와 호스트 관측값만 제거됩니다. 계획·검토 기록은 남고, 플러그인 자체는 호스트에서 별도로 제거해야 합니다.
