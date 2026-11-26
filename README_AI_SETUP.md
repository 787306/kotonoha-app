# 코토노하 (Kotonoha) v2.2 · 상황별 30일 그림 + 통합 설정 허브 + Gemini Live 가이드

## 1. PC HTML 테스트 방법 (필수: http://localhost:8080 사용)
- **Windows:** `start_local_test.bat` 더블클릭
- **macOS / Linux:** `python3 -m http.server 8080 --directory www` 실행 후 브라우저에서 `http://localhost:8080` 접속
> `file://` 직접 열기에서는 브라우저 보안 정책상 AES-GCM 암호화(Web Crypto API)와 마이크 스트리밍이 차단됩니다.

## 2. Day 1 ~ Day 30 상황별 그림 자동 전환 & 변경 방법
- **자동 전환:** 상단 에피소드 선택창 또는 홈 커리큘럼에서 Day 1 ~ Day 30을 바꾸면 해당 상황에 맞는 일러스트로 자동 변경됩니다.
- **앱 안에서 바로 그림 바꾸기:**
  1. 홈 화면 그림 우측 하단 **`🖼️ 그림 변경`** 버튼 클릭 → 내 PC/스마트폰 이미지 파일(JPG·PNG·WEBP·SVG) 선택 → 자동 최적화 후 기기 IndexedDB에 저장 (`↺ 기본` 버튼으로 언제든 원복)
  2. 우측 상단 **`⚙️ 설정 → 화면 · 보기 설정 → 에피소드별 상황 그림 관리`**에서 Day 1 ~ Day 30 전체 썸네일을 한눈에 보며 개별 변경·복원 또는 전체 기본 복원 가능
- **폴더 파일 직접 교체 (OTA / APK 기본 그림 영구 교체):**
  - `www/images/scenes/` 폴더 안에 `day01_cafe.jpg`, `day02_konbini.svg` ~ `day30_graduation.svg` 파일이 배치되어 있습니다.

## 3. ⚙️ 톱니바퀴 설정 허브 & 보안
- **엄격 보안:** 6자 이상 앱 비밀번호 설정 후 `AI · API 설정` 금고가 열리며, 모든 API 키는 `PBKDF2-SHA256 + AES-GCM-256`으로 암호화 저장됩니다.
- **OTA ↔ 독립 로컬 APK 전환:** 기본 Push는 OTA 배포(`build_mode=ota`), 최종 확정 시 GitHub Actions → `Run workflow` → `build_mode: standalone` 선택.
