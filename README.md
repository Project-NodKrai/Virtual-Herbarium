# Virtual Herbarium

React, Cloudflare Workers, R2, Workers KV와 TOTP를 사용하는 가상 식물표본관입니다. 운영 주소는 `https://virtual-herbarium.columbina.kr`입니다.

## 운영 구조

- React 빌드 결과물은 `virtual-herbarium-test` Worker의 Static Assets로 제공합니다.
- 표본의 조회·추가·수정·삭제는 모두 같은 출처의 `/api/records` API를 사용합니다. 운영 프런트엔드는 Firebase에 직접 접근하지 않습니다.
- 표본 데이터는 `HERBARIUM_BUCKET -> virtual-herbarium` R2 버킷의 `virtual-herbarium/records/v1/` 접두사 아래에 암호화된 JSON 객체로 저장합니다. 표본 ID는 `INCH-PT`와 숫자 5자리로 제한합니다.
- 표본 이미지와 로고는 기존 R2 버킷을 사용합니다. 이미지 공개 주소는 `https://data-herbarium.columbina.kr`입니다.
- OTP 사용자 목록은 전용 `OTP_STATE -> virtual-herbarium-test-otp-state` KV에 AES-256-GCM 암호문으로 저장합니다.
- OTP 검증에 성공하면 5분짜리 서명 토큰을 발급합니다. 표본과 이미지의 변경 API는 이 토큰을 확인하며, 초기 복사·복구·OTP 관리에는 관리자 권한을 요구합니다.
- 표본 목록·검색·상세·갤러리 열람은 공개됩니다.

기존 `nod-krai` Worker와 `pos-db` 버킷은 별도 프로젝트입니다. 이 저장소의 배포 대상은 `virtual-herbarium-test`와 위 운영 Custom Domain이며, 다른 프로젝트의 바인딩·DNS·데이터를 변경하지 않습니다.

## 표본 API와 변경 충돌 방지

| 요청 | 동작 | 인증과 조건 |
| --- | --- | --- |
| `GET /api/records?cursor=...` | 표본 목록 한 페이지 | 공개, `{records, cursor}` 응답 |
| `GET /api/records/:id` | 표본 상세 | 공개, `{record}`와 `ETag` 응답 |
| `PUT /api/records/:id` | 표본 생성 | OTP Bearer 토큰, `If-None-Match: *` |
| `PUT /api/records/:id` | 기존 표본 수정 | OTP Bearer 토큰, 상세 조회에서 받은 `If-Match` |
| `DELETE /api/records/:id` | 복구 가능한 표본 삭제 | OTP Bearer 토큰, 상세 조회에서 받은 `If-Match` |
| `POST /api/records/:id/restore` | 삭제한 표본 복구 | 관리자 OTP Bearer 토큰 |
| `POST /api/records/initialize` | 기존 표본 최초 복사 | 관리자 OTP Bearer 토큰, `{records: [...]}` |

목록 API는 페이지당 R2 객체를 최대 25개 읽고, 객체 읽기의 동시 실행을 최대 4개로 제한합니다. 프런트엔드는 `cursor`가 `null`이 될 때까지 다음 페이지를 조회합니다. 삭제된 객체만 있는 페이지도 다음 `cursor`가 있으면 계속 읽습니다.

생성은 같은 번호의 객체를 덮어쓰지 않습니다. 수정·삭제는 조회 당시 `ETag`와 현재 버전이 일치해야 합니다. 버전 충돌이나 중복 번호는 `409`, 변경 조건 누락은 `428`로 중단하므로 새로고침 후 다시 시도해야 합니다. R2 쓰기에도 조건을 적용해 동시 변경을 검사합니다.

삭제는 암호화된 객체에 삭제 상태를 기록하는 방식입니다. 공개 상세 API는 `404`를 반환하고 목록에서도 제외합니다. 복구를 위해 표본 정보와 연결 이미지 파일을 보존하며, 관리자 복구 API는 동일 표본을 다시 활성화합니다. 일반 생성·수정 API로 삭제된 표본을 덮어쓰거나 복구할 수 없습니다. 별도의 휴지통 화면은 아직 없습니다.

## 암호화와 OTP 유지

R2 버킷에는 이미지용 공개 도메인이 연결되어 있으므로 표본 JSON과 삭제 상태를 평문으로 저장하지 않습니다. `worker/records.ts`는 AES-256-GCM과 매번 새 12바이트 IV를 사용합니다. 객체 경로를 AAD에 포함해 다른 표본 경로로 암호문을 복사해도 해독되지 않게 합니다.

표본 암호화 키는 기존 `TOTP_STORE_ENCRYPTION_KEY`에서 `virtual-herbarium:records:key:v1` 문맥으로 별도 파생합니다. OTP 저장소와 표본 저장소의 파생 문맥·AAD가 다릅니다. 이 루트 Secret을 변경하려면 **OTP와 표본 데이터 모두 기존 키로 읽어 새 키로 재암호화**해야 합니다. 기존 Secret을 임의로 교체하면 저장된 OTP와 표본을 읽지 못합니다.

OTP 비밀값은 Worker 메모리가 아닌 암호화된 KV 저장본에 유지됩니다. 새 배포나 Worker 재시작은 OTP를 초기화하지 않습니다. `TOTP_STORE_ALLOW_BOOTSTRAP`은 운영에서 `false`이며, 저장본이 없어져도 자동으로 새 OTP를 만들지 않습니다. 기존 저장본이 있으면 `ADMIN_TOTP_SECRET`으로 덮어쓰지 않습니다.

## 기존 Firebase 표본의 초기 복사

기존 Google AI Studio 프로젝트의 서버 인증 키 발급 제한을 피하기 위해 운영 표본 저장소를 위 전용 R2 접두사로 전환합니다. Google IAM 변경, 서비스 계정 키 또는 Google 프로젝트 요금제 전환이 필요하지 않습니다. 기존 Firebase 프로젝트와 원본 데이터는 보존하며 이 API는 Firebase에 쓰지 않습니다.

초기 복사 대상은 기존 공개 표본 `INCH-PT00000` 1건입니다. 공개 사이트에서 읽은 전체 필드와 이미지 URL을 저장소 밖의 작업 산출물 `outputs/herbarium-import.json`에 백업합니다. 이 백업을 프런트엔드 번들이나 저장소에 포함하지 않습니다.

전환 절차는 다음과 같습니다.

1. 변경 브랜치를 Worker 미리보기 버전으로 업로드합니다. 초기화 완료 전 표본 API는 빈 목록을 정상 결과로 반환하지 않고 `503`으로 중단합니다.
2. 관리자 OTP로 발급받은 토큰을 사용해 미리보기의 `POST /api/records/initialize`에 `{records: [...]}`를 전달합니다.
3. 각 표본 객체를 암호화해 생성하고, 전체 복사가 끝난 뒤 암호화된 `_manifest.json`을 완료 상태로 기록합니다. 기존 객체가 있으면 동일한 데이터인지 확인하고, 내용이 다르면 덮어쓰지 않고 중단합니다.
4. 미리보기에서 개별 표본을 다시 조회해 백업의 전체 필드·이미지 URL과 비교하고 추가·수정·삭제·관리자 복구를 검증합니다.
5. 검증한 변경을 `main`에 반영해 운영 트래픽을 전환합니다.

초기 복사 중 실패하면 동일한 표본 배열로 재시도할 수 있습니다. 완료된 저장소의 초기화 재호출은 `409`이며, 일반 조회·변경 API는 완료 manifest가 있어야 동작합니다. 초기화 API는 데이터 교체나 반복 동기화 용도가 아닙니다.

## Cloudflare 설정과 배포

`wrangler.jsonc`에 Worker 이름, 운영 Custom Domain, R2·KV·Assets 바인딩이 고정되어 있습니다. 기존 리소스를 사용하므로 새 R2 버킷이나 Google 서비스 계정을 만들지 않습니다.

운영 Secret은 Cloudflare Worker 설정에만 보관합니다.

- `TOTP_STORE_ENCRYPTION_KEY`: OTP와 표본 암호화에 쓰는 기존 루트 Secret.
- `AUTH_TOKEN_SECRET`: OTP 검증 후 발급하는 서명 토큰의 기존 Secret.
- `ADMIN_TOTP_SECRET`: 최초 관리자 등록용 선택 값. 기존 KV 저장본을 대체하지 않습니다.

Secret은 GitHub, 프런트엔드 환경 변수, 로그 또는 채팅에 넣지 않습니다. 운영 R2 접근에는 API 키 대신 Worker 바인딩을 사용합니다. Firestore용 `FIREBASE_SERVICE_ACCOUNT`는 운영에 필요하지 않습니다.

Cloudflare Workers Builds는 GitHub `main` 변경을 빌드해 `npx wrangler deploy`로 운영 배포합니다. 다른 브랜치는 `npx wrangler versions upload`로 미리보기 버전을 만들며 운영 트래픽을 전환하지 않습니다.

별도 `.github/workflows/deploy-worker.yml`도 `main` push 또는 수동 실행 시 배포를 시도합니다. 이 GitHub Actions 경로를 사용하려면 저장소 Actions secrets에 `CLOUDFLARE_ACCOUNT_ID`와 `CLOUDFLARE_API_TOKEN`이 필요합니다. Cloudflare의 네이티브 GitHub 빌드 연결과는 별도 경로입니다.

## 로컬 검증

```bash
npm ci
npm test
npm run lint
npm run build
npx wrangler deploy --dry-run
npx wrangler dev
```

테스트는 실제 운영 데이터나 OTP를 사용하지 않는 격리된 저장소 모형으로 암호화, 초기 복사, 충돌 방지, 추가·수정·삭제·복구, 페이지 제한과 OTP 화면 전환을 확인합니다. `wrangler dev`는 기본적으로 로컬 R2·KV를 사용하므로 운영 데이터를 자동으로 가져오지 않습니다.

## 비용

기존 R2 버킷을 사용하며 새 유료 플랜을 신청하지 않습니다. R2 Standard의 월 무료 포함량은 저장 용량 10 GB-month, Class A 요청 100만 건, Class B 요청 1,000만 건입니다. 포함량을 넘으면 기존 계정의 과금 설정에 따라 사용량 요금이 발생할 수 있습니다. [Cloudflare R2 공식 요금표](https://developers.cloudflare.com/r2/pricing/)

목록 페이지 크기와 동시 읽기 수 제한은 한 요청의 저장소 작업량을 줄입니다. **월 과금 하드캡이나 무료 포함량 초과 시 자동 차단은 구현되어 있지 않으며, 무과금을 보장하지 않습니다.** R2 외의 Worker·KV 등은 해당 서비스와 계정의 요금·한도가 별도로 적용됩니다. 표본 삭제 후에도 복구용 데이터와 이미지는 저장 용량에 포함됩니다.

## 기존 코드와 후속 작업

`server.ts`, Firebase 설정 및 관련 파일은 이전 Express 서버 비교·복구용으로 남아 있습니다. 현재 운영 Worker의 표본 API 경로에서는 사용하지 않습니다. 기존 Node 서버 빌드는 `npm run build:legacy`, 실행은 `npm run start:legacy`로 수행합니다.

768px 미만 화면에서는 홈·표본관·갤러리 하단 탭과 상단 전체 메뉴를 제공합니다. 통계와 OTP 관리는 전체 메뉴에서 이동합니다. 768px 이상에서는 기존 상단 메뉴와 사이드바를 유지합니다.
