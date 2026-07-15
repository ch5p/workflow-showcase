# Security Policy

## Supported version

현재 보안 수정 대상은 최신 0.1.x source beta입니다. 실행파일 배포본은 아직 제공하지 않습니다.

## Reporting a vulnerability

공개 Issue에 취약점 상세, 사용자 경로, 영상 또는 Job 파일을 올리지 마세요.

GitHub 저장소의 Security 탭에 `Report a vulnerability` 버튼이 보이면 private vulnerability report를 작성해 주세요.

https://github.com/ch5p/character-workflow-portable/security/advisories/new

버튼을 사용할 수 없다면 상세 정보 없이 제목이 `Security contact request`인 Issue만 열어 주세요. 공개 댓글에 재현 정보나 민감한 파일을 쓰지 마세요.

보고에는 재현 절차, 영향 범위, 사용한 버전과 가능한 최소 fixture만 포함해 주세요. 실제 프로젝트 데이터와 인증정보는 제거해야 합니다.

## Scope notes

이 앱은 로컬 파일을 current-job으로 복사하고 FFmpeg를 실행합니다. path boundary 우회, 임의 파일 읽기·삭제, IPC 검증 우회, Export process orphan은 보안 이슈로 취급합니다.
