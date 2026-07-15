# Premiere Synthetic XML Export Guide

이 키트는 공개 저장소의 실제 Premiere `xmeml` 통합 테스트 자료를 만들기 위한 중립 더미 소스입니다. 실제 프로젝트 파일이나 개인 미디어를 사용하지 않습니다.

## 만들어야 할 결과물

Premiere에서 아래 두 파일을 출력해 Codex 대화에 첨부합니다.

- `premiere-synthetic.xml`
- `premiere-synthetic-final.mp4`

Premiere가 `FCP Translation Results` 로그를 만들었다면 그 로그도 함께 첨부합니다. 사용하는 Premiere의 정확한 버전도 메시지에 적습니다.

`.prproj`와 원본 소스 MP4는 다시 첨부하지 않아도 됩니다.

## 제공된 소스

`media/` 폴더에 다음 영상이 있습니다.

| 파일 | 화면 색상 | 용도 |
|---|---|---|
| `clip-a.mp4` | 빨강 | 같은 source를 두 번 사용하는 SHOT identity 검증 |
| `clip-b.mp4` | 파랑 | V1 기본 컷 |
| `clip-c.mp4` | 초록 | V1 마지막 컷 |
| `overlay-d.mp4` | 보라 | V2 최상단 활성 클립 검증 |
| `disabled-e.mp4` | 노랑 | disabled clip 제외 검증 |

모든 파일은 H.264, 1280×720, 24 fps, 6초, 무음입니다.

## Premiere 프로젝트 만들기

1. 새 빈 프로젝트를 만들고 이름을 `workflow-fixture`로 정합니다.
2. `media/`의 MP4 다섯 개를 모두 Import합니다.
3. `clip-a.mp4`를 New Item 버튼으로 드래그해 소스와 같은 설정의 Sequence를 만듭니다.
4. Sequence 이름을 `synthetic-timeline`으로 바꿉니다.
5. Sequence가 1280×720, 24 fps, progressive인지 확인합니다.
6. 처음 자동으로 놓인 클립은 제거한 뒤 아래 표대로 다시 배치합니다.

## 타임라인 배치

Sequence 시작은 `00:00:00:00`, 전체 길이는 정확히 12초로 만듭니다.

| 트랙 | 시작 | 종료 | 파일 | 작업 |
|---|---:|---:|---|---|
| V1 | 00:00 | 00:03 | `clip-a.mp4` | 앞 3초 사용 |
| V1 | 00:03 | 00:06 | `clip-b.mp4` | 앞 3초 사용 |
| V1 | 00:06 | 00:09 | `clip-a.mp4` | 같은 Project item을 다시 사용 |
| V1 | 00:09 | 00:12 | `clip-c.mp4` | 앞 3초 사용 |
| V2 | 00:02 | 00:05 | `overlay-d.mp4` | 앞 3초 사용 |
| V2 | 00:07 | 00:08 | `disabled-e.mp4` | 1초만 사용한 뒤 우클릭 `Enable` 해제 |

간단히 보면 다음 구조입니다.

```text
TIME  00      02  03      05  06  07  08  09      12
V2            [ OVERLAY D ]       [E disabled]
V1    [ A ]   [  B  ]      [  A  ]       [   C   ]
```

`clip-a.mp4`는 새 복사본을 만들지 말고 같은 Project item을 V1에 두 번 배치합니다.

## 넣지 말아야 할 것

이 실제 Premiere export fixture는 편집 구조만 검증합니다. 아래 항목을 추가하지 않습니다.

- Cross Dissolve 또는 다른 transition
- 좌우 반전, Transform, Crop 등의 effect/filter
- mask, keyframe, color adjustment
- speed change 또는 time remapping
- nested sequence, multicam
- audio edit

전환의 `<transitionitem>`과 `start/end = -1` 형태는 실제 Premiere fixture와 분리한 손작성 synthetic XML에서 테스트합니다.

## 완성 영상 출력

1. Sequence 전체 12초를 선택합니다.
2. `File > Export > Media`를 엽니다.
3. Format은 H.264로 설정합니다.
4. 출력 크기 1280×720, frame rate 24 fps를 확인합니다.
5. 파일명을 `premiere-synthetic-final.mp4`로 저장합니다.

무음 영상이 정상입니다. 이 fixture는 audio stream copy를 검증하지 않습니다.

## XML 출력

1. Project 패널 또는 Timeline에서 `synthetic-timeline` Sequence를 선택합니다.
2. `File > Export > Final Cut Pro XML`을 선택합니다.
3. 파일명을 `premiere-synthetic.xml`로 저장합니다.
4. Premiere가 Translation Results 로그를 표시하면 함께 보관합니다.

## 보내기 전 확인

- [ ] 최종 영상 길이가 12초인가
- [ ] 최종 영상이 24 fps인가
- [ ] 2–5초에 보라색 `OVERLAY D`가 보이는가
- [ ] 7–8초에 노란색 `DISABLED E`가 보이지 않고 빨간색 `CLIP A`가 보이는가
- [ ] XML과 최종 MP4의 Sequence 길이가 같은가
- [ ] transition, effect, mask, speed change를 넣지 않았는가

## 공개 전 정리 원칙

Premiere가 만든 raw XML에는 로컬 절대 경로, UUID, application-specific metadata가 포함될 수 있습니다. raw XML을 그대로 Git에 추가하지 않습니다. Codex가 다음 작업을 한 뒤 공개 fixture로 사용합니다.

- Project와 Sequence 이름 확인
- clip 이름과 source identity 확인
- 사용자 절대 경로 제거 또는 중립화
- UUID와 불필요한 Premiere metadata 검토
- 정리 전후 parser 결과 비교
- 공개용 synthetic fixture와 원본 raw export 분리

완성 MP4가 효과와 최종 화면의 시각적 기준이며, XML은 clip timing, video-track order, enabled state, source identity를 위한 구조 데이터입니다.

## 검증 완료된 공개 fixture

이 안내서로 만든 실제 Premiere export를 검증하고 공개용으로 정리했습니다.

- [`public-fixture/premiere-synthetic.xml`](public-fixture/premiere-synthetic.xml)
- [`public-fixture/premiere-synthetic-final.mp4`](public-fixture/premiere-synthetic-final.mp4)
- 제작·정리·검증 기록: [`public-fixture/SOURCE_NOTES.md`](public-fixture/SOURCE_NOTES.md)

`public-fixture/`에는 정리된 공개본만 둡니다. Premiere가 처음 만든 raw XML, 원본 첨부 파일, Translation Results 로그는 로컬 검증 자료로만 보관하고 Git에 추가하지 않습니다.
