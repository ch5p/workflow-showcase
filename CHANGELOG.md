# Changelog

## 0.1.0-beta.2

- single-instance guard와 durable Current Job 저장 강화
- 저장 경로의 symlink/junction 이탈 차단
- 영상 커밋 전 Electron decode·metadata 사전검증
- 렌더 완료 뒤 파일명 교체 실패 시 `.part.mp4` 보존
- Current Job 새로고침 아이콘과 `TO START` 명칭 정리
- 콜아웃 글자 하단 잘림과 subtitle shadow 수정
- 임베드 프리뷰 drop을 공식 XML/video import transaction으로 연결

## 0.1.0-beta.1

- legacy xmeml 기반 PRIMARY timeline과 SHOT reference workflow 공개
- UPDATE XML과 NEW JOB 안전 분리
- Windows 파일 잠금 대응 transaction rollback과 recovery
- XML, video, reference drop zones
- pure parser, PRIMARY timeline, SHOT, reference mapping core 분리
- classic render spec과 presentation CSS 분리
- 실제 current-job을 건드리지 않는 격리 smoke와 Export smoke
- Premiere Pro 2026 synthetic XML과 MP4 fixture
