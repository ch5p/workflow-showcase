# Character Workflow Portable MVP

한 번의 영상 작업을 빠르게 구성하고 다시 열 수 있는 Electron 기반 로컬 앱입니다. 별도 서버 없이 이 폴더 안에서 XML, 원본 영상, 레퍼런스, 설정을 함께 관리합니다.

## 실행

1. 이 폴더에서 `npm.cmd start`를 실행합니다.
2. `LOAD XML`로 Premiere/Final Cut Pro XML을 불러옵니다.
3. `LOAD VIDEO`로 XML과 같은 완성본 영상을 불러옵니다.
4. `ADD FILES`로 이미지·영상 레퍼런스를 추가합니다.
5. 레퍼런스를 `GLOBAL BASE` 또는 원하는 `SHOT`에 드래그합니다.

파일은 `current-job` 아래로 복사되므로 원본 위치가 바뀌어도 현재 작업은 유지됩니다. 앱 폴더 전체를 옮길 때도 내부 상대 경로를 사용합니다.

## 현재 범위

- 기존 FCP XML 파서 재사용
- 실제 XML 기반 SHOT/EDIT 레일
- GLOBAL/SHOT 레퍼런스 매핑 및 자동 저장
- 영상 재생, 리셋, SHOT 탐색, Clean Preview
- Electron offscreen raw-frame 기반 H.264 12 Mbps / 60 fps MP4 출력
- NVENC 우선, 실패 시 libx264 자동 fallback, AAC 오디오 보존

`EXPORT H.264`를 누르면 `current-job/output`에 새 MP4가 생성됩니다. 렌더 중 버튼에는 진행률이 표시되며 같은 버튼을 다시 누르면 취소됩니다.
