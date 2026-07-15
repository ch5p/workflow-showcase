# XML Compatibility

## Supported in this beta

Character Workflow Portable은 legacy Final Cut Pro 7 XML Interchange Format인 xmeml을 읽습니다.

현재 검증 범위:

- sequence name, duration, timebase
- video track과 clipitem timing
- source in과 out
- track 우선순위를 이용한 PRIMARY timeline
- enabled가 FALSE인 clip 제외
- 반복 file reference를 이용한 source identity
- transitionitem의 끝점을 sequence content length에 포함
- transition에 물린 start 또는 end가 -1인 clip의 제한적 duration 복원

주 검증 fixture는 Adobe Premiere Pro 2026 v26.2.2 (Build 3)에서 Final Cut Pro XML로 내보냈습니다.

## Not supported

- modern Final Cut Pro XML (.fcpxml)
- CapCut project
- Premiere project (.prproj)
- nested sequence와 multicam의 완전한 해석
- speed change와 time remapping
- audio edit 구조의 재현

CapCut은 공식 timeline XML export를 제공하지 않으므로 직접 지원하지 않습니다.

## Effects and transitions

XML에 filter 또는 effect metadata가 존재하더라도 이 beta parser는 효과를 해석하거나 재현하지 않습니다.

예:

- 좌우 반전
- Transform과 Crop
- mask
- keyframe
- color adjustment
- dissolve의 시각 효과

transitionitem은 일부 clip boundary와 content length 계산에만 쓰입니다. 결과 화면의 기준은 XML이 아니라 같은 sequence에서 내보낸 완성본 영상입니다.

## Contributions

FCPXML adapter 기여는 기존 xmeml parser를 수정하지 않고 공통 timeline model로 정규화하는 별도 입력 adapter로 제안해 주세요. synthetic fixture와 기존 parser 회귀 검사가 반드시 필요합니다.
