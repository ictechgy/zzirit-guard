<p align="center">
  <img src="assets/logo/zzirit-guard-mark.svg" width="160" alt="찌리릿 가드 로고">
</p>

# 찌리릿 가드 (zzirit-guard)

치지직 스트리머와 채팅 매니저를 위한 **채팅 관리 보조 도구**입니다. 규칙과 로컬 AI로 악플·도배를 빠르게 찾아 매니저에게 올리고, 확실한 것만(켜 두었을 때) 자동으로 숨깁니다.

*Unofficial moderation assistant for CHZZK live chat. All AI runs locally on the operator's machine.*

> **비공식 프로젝트입니다.** 네이버·치지직과 관계가 없으며, 치지직 Open API를 사용합니다.

## 상태

**설계 단계**이며, 아직 실행할 수 있는 코드는 없습니다.

- [설계 스펙](docs/superpowers/specs/2026-10-11-zzirit-guard-design.md)
- [스파이크: 로컬 가드 모델 비교](docs/spikes/2026-10-11-guard-models/README.md)

## 계획한 특징

- **채팅을 외부로 보내지 않습니다.** 모든 판정을 운영자의 맥 안에서 합니다(규칙 → KcELECTRA → kanana-safeguard).
- **자동 숨김 스위치는 기본 꺼짐입니다.** 꺼져 있는 동안에는 "켜져 있었으면 숨겼을" 메시지만 보여 주는 섀도 모드로 동작합니다.
- **제재는 사람만 합니다.** AI는 후보를 올리기만 합니다.
- 매니저는 휴대폰 브라우저(PWA)로 씁니다.

## 운영하려는 분께(구현 후)

이 프로젝트를 설치해서 운영하는 사람은 다음을 직접 책임집니다.

- **치지직 개발자 앱은 각자 등록합니다.** Client ID·Secret과 토큰은 누구와도 공유하지 않습니다(치지직 Developers 이용약관 제7조②11호·③).
- **유료화와 광고는 금지입니다**(제7조②13호). 대가를 받으려면 치지직과 별도로 제휴해야 합니다.
- **치지직 API 사용 사실을 치지직이 지정한 방식으로 표시합니다**(제7조④).
- **개인정보:** 스트리머와 서면 합의를 하고, 채널 공지에 자동 숨김 기준과 이의 제기 경로를 올리고(개인정보보호법 제37조의2), 보관 기간을 설정합니다.
- **백업 보관:** 매일 만드는 백업을 7개까지 남기므로, 보관 기간이 지나 DB에서 지운 채팅 원문도 백업 안에는 최대 7일 더 남습니다. 스트리머 합의서와 채널 공지에 이 기간을 함께 적습니다.

## 라이선스

[Apache License 2.0](LICENSE)

## 출처 표기

모델 가중치와 데이터셋은 이 저장소에 포함하지 않습니다. 설치할 때 각 공식 저장소에서 받습니다.

| 구성 요소 | 라이선스 |
|---|---|
| [kakaocorp/kanana-safeguard-8b](https://huggingface.co/kakaocorp/kanana-safeguard-8b) | Apache-2.0 |
| [beomi/KcELECTRA-base](https://huggingface.co/beomi/KcELECTRA-base) | MIT |
| [humane-lab/K-HATERS](https://huggingface.co/datasets/humane-lab/K-HATERS) | CC-BY 4.0 |

> ⚠️ `docs/spikes/2026-10-11-guard-models/chat_samples.jsonl`에는 탐지 성능을 시험하려고 직접 작성한 욕설·혐오 표현이 들어 있습니다.
