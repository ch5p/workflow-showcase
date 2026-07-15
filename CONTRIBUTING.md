# Contributing

기여해 주셔서 감사합니다. 이 beta는 작은 변경과 재현 가능한 검증을 우선합니다.

## Local setup

- Windows 10 또는 11
- Node.js 22.12 이상
- Export 검사에는 FFmpeg 필요

설치와 기본 검사:

    npm.cmd ci
    npm.cmd run check
    npm.cmd run smoke

Export 변경 시:

    npm.cmd run smoke:export

모든 smoke는 임시 Job에서 실행되어야 합니다. 테스트가 실제 current-job을 읽거나 쓰도록 변경하지 마세요.

## Pull request scope

하나의 PR에는 하나의 목적만 담아 주세요. PR 설명에는 다음을 포함합니다.

- Summary
- Stable contracts touched
- Validation
- Risk
- Screenshot 또는 output 비교

parser, SHOT identity, reference mapping, Job path, IPC, Export fallback을 수정한다면 먼저 fixture와 회귀 검사를 추가해야 합니다.

## Fixtures and privacy

실제 작업 XML, 영상, 레퍼런스, 사용자 경로를 commit하지 마세요.

새 fixture는 다음 조건을 만족해야 합니다.

- synthetic 또는 재배포 권리가 명확한 데이터
- 로컬 절대경로와 개인 UUID 제거
- expected fps, duration, track, in/out, enabled 결과 문서화
- 원본과 정리본의 parser 결과 비교
- 제3자 음악, 음성, 이미지 미포함

## Layout contributions

공식 앱에 runtime preset system을 먼저 추가하지 마세요. 16:9, 9:16, 1:1, 4:5 실험은 포크 또는 community-layout 제안으로 시작하고 screenshot과 Export 검증을 첨부해 주세요.
