# Public Premiere Fixture Source Notes

## 목적

이 폴더의 XML과 MP4는 같은 Adobe Premiere Pro Sequence에서 내보낸 한 쌍의 공개 fixture입니다.

- `premiere-synthetic.xml`: 컷 타이밍, 비디오 트랙 순서, `enabled` 상태, 반복 소스 identity를 검증하는 구조 기준
- `premiere-synthetic-final.mp4`: Premiere에서 보인 최종 화면을 확인하는 시각 기준

앱에 기존 `current-job/job.json`이 없으면 이 두 파일을 최초 실행용 `SAMPLE JOB`으로 복사합니다. 일반 사용자 Job이나 기존 작업 위에는 자동으로 복사하지 않습니다.

XML은 효과가 적용된 최종 화면의 완전한 표현이 아닙니다. 화면 판단은 MP4를 기준으로 합니다.

## 제작 정보

- Source kit: [`../media/`](../media/)
- 제작 절차: [`../PREMIERE_EXPORT_GUIDE.md`](../PREMIERE_EXPORT_GUIDE.md)
- Sequence: `synthetic-timeline`
- Sequence 사양: 1280×720, 24 fps, progressive, 13초/312프레임
- 내보내기 도구: Adobe Premiere Pro
- Premiere 정확한 version/build: Adobe Premiere Pro 2026, v26.2.2 (Build 3)
- Translation Results: Premiere가 `검정 비디오 (Black Video)` 합성 항목을 변환하지 않고 Slug 자리 표시자를 사용했다고 알림

XML 안의 `Final Cut Pro 7.0` 표기는 Premiere 버전이 아니라 내보낸 interchange 형식의 application metadata입니다.

## 기대 타임라인

| Track | Source | Timeline frames | Source in/out | Enabled |
| --- | --- | ---: | ---: | --- |
| V1 | `clip-a.mp4` | 0–72 | 0–72 | `TRUE` |
| V1 | `clip-b.mp4` | 72–144 | 0–72 | `TRUE` |
| V1 | `clip-a.mp4` | 144–216 | 0–72 | `TRUE` |
| V1 | `clip-c.mp4` | 216–288 | 0–72 | `TRUE` |
| V1 | `색상 매트 (Color Matte)` generator | 288–312 | 86400–86424 | `TRUE` |
| V2 | `overlay-d.mp4` | 48–120 | 0–72 | `TRUE` |
| V2 | `disabled-e.mp4` | 168–192 | 0–24 | `FALSE` |
| V3 | `조정 레이어 (Adjustment Layer)` | 0–288 | 0–288 | `TRUE` |

반복된 두 `clip-a.mp4` clipitem은 같은 `file id`와 `masterclipid`를 공유합니다. `overlay-d.mp4`는 Premiere의 Overlay 합성 모드와 위쪽 위치 이동을 사용하며, 최종 합성 화면은 MP4에 반영됩니다. V3의 Adjustment Layer는 pathless Slug로 기록되며 앱이 PRIMARY 검사 전에 제외합니다. 마지막 1초의 Color Matte는 XML의 Sequence 길이를 312프레임으로 유지하지만 별도의 SHOT/EDIT으로 노출되지 않습니다.

## 편집 기능 범위

이 fixture는 실제 Premiere `xmeml`의 기본 편집 구조와 함께 `overlay-d.mp4`의 합성 모드·위치, 자동 제외되는 Adjustment Layer, 마지막 1초 Color Matte를 포함합니다. 다음 기능은 의도적으로 넣지 않았습니다.

- transition과 dissolve
- 지정된 Overlay 합성·위치 외의 좌우 반전, Transform, Crop
- mask, keyframe, color adjustment
- speed change, time remapping
- nested sequence, multicam

전환의 `<transitionitem>`과 `start/end = -1` 형태는 별도의 손작성 edge-case XML로 다룹니다.

## 공개용 정리 내역

원본 첨부 파일은 Git에 넣지 않았습니다. 공개 XML은 실제 Premiere export 구조를 유지하면서 다음 항목만 바꿨습니다.

- 로컬 절대 `pathurl` 5개를 `file://localhost/fixtures/premiere-export-kit/media/...` 형태로 중립화
- Sequence UUID를 고정된 synthetic UUID로 치환

`appspecificdata`, 빈 `logginginfo`, `labels`, file/reference 구조는 실제 export 형태를 보존하기 위해 유지했습니다. 정리 전후의 타임라인 구조 contract(`fps`, duration, track, clip name, start/end, in/out, enabled, file/master ID)는 동일합니다.

초기 MP4의 Premiere `creatorAtom` 바이너리 영역에서 Windows 사용자 프로젝트 경로가 뒤늦게 확인되었습니다. 공개 MP4는 재인코딩 없이 H.264/AAC 스트림을 복사하는 metadata 제거 remux로 교체했습니다. 영상·오디오 비트스트림 SHA-256은 원본과 같고, 로컬 사용자 경로는 바이너리 검사에서 제거된 것을 확인했습니다.

remux 결과 영상은 그대로 13초·312프레임이지만 AAC 컨테이너 끝길이는 `13.013333초`입니다. XML과의 차이는 1프레임보다 작아 DURATION 경고 대상이 아니며, 영상 타임라인 contract에도 영향이 없습니다. 공개 MP4는 원본과 바이트 단위로 같은 파일이 아닙니다.

## MP4 참고

- Video: H.264 Main, 1280×720, yuv420p, progressive, 24 fps, 312 frames
- Audio: AAC-LC, 48 kHz, stereo, 컨테이너 기준 13.013333초
- 오디오 최대 음량: 약 -91 dB로 사실상 무음

이 fixture는 시각 기준이며 오디오 내용이나 동기 정확성을 검증하지 않습니다.

## 검증 결과

- 실제 타임라인과 안내서의 frame contract 일치
- `transitionitem`: 0
- `filter`: 2 (`overlay-d.mp4`의 Basic Motion과 Opacity)
- `generatoritem`: 1 (마지막 1초 Color Matte)
- 비활성 clipitem: 1
- 공개 XML에 사용자 절대 경로·원본 UUID 없음
- 정리 전후 XML 타임라인 구조 contract 동일
- 공개 MP4 바이너리에 Windows 사용자 경로 없음
- 공개 MP4와 제공 원본의 H.264/AAC 비트스트림 SHA-256 동일

## 사용자 시각 검수

최종 시각 검수는 2026-07-18 maintainer 확인으로 `Passed`입니다. 자동 metadata/parser 검증과 별도로 아래 화면과 불러오기 동선을 직접 확인했습니다.

- [x] 2–5초 구간에서 위로 이동한 `OVERLAY D`가 아래 CLIP A/B와 합성되어 보임
- [x] 7–8초 구간에 비활성 노란색 `DISABLED E`가 보이지 않고 빨간색 `CLIP A`가 보임
- [x] 12–13초 구간에 검정 Color Matte가 보이며 XML과 MP4가 13초로 끝남
- [x] 앱에서 5 EDITS / 4 SHOTS가 유지되고 새 XML·MP4 불러오기가 정상 동작함

## SHA-256

| File | SHA-256 |
| --- | --- |
| Raw `synthetic-timeline_4.xml` | `833A7AC77DB43BE013CA20ABACAD1E82AA9E5E494C6C809ACCB2025031C79B09` |
| Public `premiere-synthetic.xml` | `B7C0488817E61D5ABA72B2F9F05DFE4C70BC9150B7D420839C9853F2ABBC52A1` |
| Raw `synthetic-timeline_4.mp4` (not published) | `AFF7CF81ED722F30EE7DE7085F701672BE2B4D341835F4D6C9E55D60449A8778` |
| Sanitized public MP4 | `D13145F1C50DB330161FB5098CAA160B9474DB02457252E0137962D35DB825D8` |

## 권리 메모

영상은 이 fixture를 위해 만든 단색 카드와 텍스트 라벨만 사용하며, 제3자 영상·음악·음성은 포함하지 않습니다. 이 폴더의 XML, MP4와 source media는 저장소 루트의 MIT License 적용 범위에 포함됩니다.
