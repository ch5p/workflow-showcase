# Local Working Rules

- `HANDOFF.md`의 Red Zone과 `docs/PROJECT_MAP.md`의 Current Job Contract를 먼저 확인합니다.
- 기존 FCP XML 파서를 다시 작성하지 않습니다.
- 새 기능은 기존 출력 프리뷰를 대체하지 말고 Electron 브리지와 옵션으로 확장합니다.
- 수정 전 최신 파일 복사본을 남기고, 사용자 절대 경로를 코드나 Job 데이터에 넣지 않습니다.
- QA는 먼저 `npm.cmd run check`, 다음 `npm.cmd run smoke` 순서로 짧게 수행합니다.
- 오류는 `current-job/logs/app.log`에 재현 가능한 이벤트로 남깁니다.
