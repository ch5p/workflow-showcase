# Public Premiere Fixture Source Notes

## 목적

이 폴더의 XML과 MP4는 같은 Adobe Premiere Pro Sequence에서 내보낸 한 쌍의 공개 fixture입니다.

- `premiere-synthetic.xml`: 컷 타이밍, 비디오 트랙 순서, `enabled` 상태, 반복 소스 identity를 검증하는 구조 기준
- `premiere-synthetic-final.mp4`: Premiere에서 보인 최종 화면을 확인하는 시각 기준

XML은 효과가 적용된 최종 화면의 완전한 표현이 아닙니다. 화면 판단은 MP4를 기준으로 합니다.

## 제작 정보

- Source kit: [`../media/`](../media/)
- 제작 절차: [`../PREMIERE_EXPORT_GUIDE.md`](../PREMIERE_EXPORT_GUIDE.md)
- Sequence: `synthetic-timeline`
- Sequence 사양: 1280×720, 24 fps, progressive, 12초/288프레임
- 내보내기 도구: Adobe Premiere Pro
- Premiere 정확한 version/build: Adobe Premiere Pro 2026, v26.2.2 (Build 3)
- Translation Results: 제공되지 않음

XML 안의 `Final Cut Pro 7.0` 표기는 Premiere 버전이 아니라 내보낸 interchange 형식의 application metadata입니다.

## 기대 타임라인

| Track | Source | Timeline frames | Source in/out | Enabled |
| --- | --- | ---: | ---: | --- |
| V1 | `clip-a.mp4` | 0–72 | 0–72 | `TRUE` |
| V1 | `clip-b.mp4` | 72–144 | 0–72 | `TRUE` |
| V1 | `clip-a.mp4` | 144–216 | 0–72 | `TRUE` |
| V1 | `clip-c.mp4` | 216–288 | 0–72 | `TRUE` |
| V2 | `overlay-d.mp4` | 48–120 | 0–72 | `TRUE` |
| V2 | `disabled-e.mp4` | 168–192 | 0–24 | `FALSE` |

반복된 두 `clip-a.mp4` clipitem은 같은 `file id`와 `masterclipid`를 공유합니다. Premiere가 만든 V3는 비어 있으며 파서 결과에 영향을 주지 않습니다.

## 포함하지 않은 편집 기능

이 fixture는 실제 Premiere `xmeml`의 기본 편집 구조만 검증합니다. 다음 기능은 의도적으로 넣지 않았습니다.

- transition과 dissolve
- effect/filter, 좌우 반전, Transform, Crop
- mask, keyframe, color adjustment
- speed change, time remapping
- nested sequence, multicam

전환의 `<transitionitem>`과 `start/end = -1` 형태는 별도의 손작성 edge-case XML로 다룹니다.

## 공개용 정리 내역

원본 첨부 파일은 Git에 넣지 않았습니다. 공개 XML은 실제 Premiere export 구조를 유지하면서 다음 항목만 바꿨습니다.

- 로컬 절대 `pathurl` 5개를 `file://localhost/fixtures/premiere-export-kit/media/...` 형태로 중립화
- Sequence UUID를 고정된 synthetic UUID로 치환

`appspecificdata`, 빈 `logginginfo`, `labels`, file/reference 구조는 실제 export 형태를 보존하기 위해 유지했습니다. 정리 전후의 타임라인 구조 contract(`fps`, duration, track, clip name, start/end, in/out, enabled, file/master ID)는 동일합니다.

MP4에서는 개인 식별 메타데이터가 발견되지 않았습니다. 메타데이터 제거 remux가 AAC 끝길이를 약 0.0107초 바꾸는 것을 확인했기 때문에, 공개 MP4는 원본과 바이트 단위로 같은 파일을 사용합니다. 생성 시각과 일반적인 MainConcept handler metadata는 남아 있습니다.

## MP4 참고

- Video: H.264 Main, 1280×720, yuv420p, progressive, 24 fps, 288 frames
- Audio: AAC-LC, 48 kHz, stereo, 12초
- 오디오 최대 음량: 약 -91 dB로 사실상 무음

이 fixture는 시각 기준이며 오디오 내용이나 동기 정확성을 검증하지 않습니다.

## 검증 결과

- 실제 타임라인과 안내서의 frame contract 일치
- `transitionitem`: 0
- `filter`: 0
- 비활성 clipitem: 1
- 공개 XML에 사용자 절대 경로·원본 UUID 없음
- 정리 전후 XML 타임라인 구조 contract 동일
- 공개 MP4와 제공 원본의 SHA-256 동일

## 사용자 시각 검수

최종 시각 판단은 사용자 담당이며 현재 상태는 `Pending`입니다. 자동 metadata/parser 검증은 아래 항목의 사용자 확인을 대체하지 않습니다.

- 2–5초 구간에 보라색 `OVERLAY D`가 보이는지
- 7–8초 구간에 비활성 노란색 `DISABLED E`가 보이지 않고 빨간색 `CLIP A`가 보이는지
- 전체 길이 12초 동안 기대 타임라인 순서와 최종 MP4 화면이 일치하는지

## SHA-256

| File | SHA-256 |
| --- | --- |
| Raw `synthetic-timeline.xml` | `8AB01405F930FA648745A6E550EFA5953DD42167C42B2B03FBFCC28796408088` |
| Public `premiere-synthetic.xml` | `A86461A668355E75AE9FF65AB572436D353FEF25D0DC2D07E6BD00A26A13F64A` |
| Raw/Public MP4 | `045D67722997455E424CCA423978DEDC8B39AB7C4E364F0A12567C78E08589F2` |

## 권리 메모

영상은 이 fixture를 위해 만든 단색 카드와 텍스트 라벨만 사용하며, 제3자 영상·음악·음성은 포함하지 않습니다. 공개 저장소의 LICENSE를 확정할 때 fixture media의 재배포 조건도 함께 명시해야 합니다.
