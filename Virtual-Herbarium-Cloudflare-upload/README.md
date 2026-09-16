# Virtual Herbarium_TEST

React, Firestore, Cloudflare Workers, R2, Workers KV, TOTP를 사용하는 가상 식물표본관입니다.

## Cloudflare 구성

- React 결과물은 Workers Static Assets로 제공합니다.
- `/api/*` 요청만 `worker/index.ts`가 처리합니다.
- 이미지는 `HERBARIUM_BUCKET` R2 바인딩을 통해 `virtual-herbarium` 버킷에 저장합니다.
- OTP 사용자 목록은 `OTP_STATE` KV에 AES-256-GCM 암호문으로 저장합니다.
- OTP 검증에 성공하면 5분짜리 서명 토큰을 발급합니다. 이미지 업로드·삭제 API와 OTP 관리 API는 이 토큰을 확인합니다.
- 조회·검색·상세 열람에는 OTP를 요구하지 않습니다.

기존 `nod-krai` Worker와 `pos-db` 버킷은 이 프로젝트와 무관하며 변경하지 않습니다. 이 프로젝트는 별도 Worker 이름인 `virtual-herbarium-test`를 사용합니다.

## OTP 초기화 방지

Worker 인스턴스 메모리에 OTP 비밀값을 저장하지 않습니다. 암호화된 KV 저장본을 매번 읽으므로 새 배포나 Worker 재시작 후에도 OTP가 유지됩니다.

`TOTP_STORE_ALLOW_BOOTSTRAP`은 기본적으로 `false`입니다. 암호화된 저장본이 사라졌을 때 자동으로 새 OTP를 만들지 않고 오류로 중단합니다.

최초 한 번만 다음 중 한 방법으로 초기화합니다.

1. 기존 인증기의 Base32 비밀값을 `ADMIN_TOTP_SECRET` Worker secret으로 설정하고 bootstrap을 활성화합니다.
2. `ADMIN_TOTP_SECRET`을 설정하지 않고 bootstrap을 활성화한 다음 `/security`에서 새 관리자 QR을 등록합니다.

저장 상태를 확인한 뒤 반드시 `TOTP_STORE_ALLOW_BOOTSTRAP`을 다시 `false`로 배포합니다. 기존 KV 저장본이 있으면 `ADMIN_TOTP_SECRET`은 절대로 덮어쓰지 않습니다.

> 이전에 외부에 노출된 OTP seed 또는 R2 API key는 재사용하지 마세요. Worker는 R2 API key 대신 R2 binding을 사용합니다.

## 로컬 검증

```bash
npm ci
npm run lint
npm run build
npx wrangler dev
```

`wrangler dev`는 기본적으로 로컬 KV와 로컬 R2 데이터를 사용합니다.

## 최초 Cloudflare 배포

`wrangler.jsonc`에는 다음이 설정되어 있습니다.

- 새 Worker: `virtual-herbarium-test`
- 기존 R2 버킷 binding: `HERBARIUM_BUCKET -> virtual-herbarium`
- 새 전용 KV binding: `OTP_STATE -> virtual-herbarium-test-otp-state`
- 시험 주소: `*.workers.dev`

이 프로젝트만 사용하는 `virtual-herbarium-test-otp-state` KV가 별도로 연결되어 있습니다. 기존 Worker와 DNS 레코드는 변경하지 않습니다.

먼저 민감한 값을 대시보드 또는 Wrangler secret으로 등록합니다.

```bash
npx wrangler secret put TOTP_STORE_ENCRYPTION_KEY
npx wrangler secret put AUTH_TOKEN_SECRET
```

각 값은 서로 다른 32자 이상의 무작위 문자열을 사용합니다. 기존 인증기 OTP를 그대로 이어 쓸 때만 아래 secret도 추가합니다.

```bash
npx wrangler secret put ADMIN_TOTP_SECRET
```

첫 초기화 때만 `wrangler.jsonc`의 `TOTP_STORE_ALLOW_BOOTSTRAP`을 `true`로 바꿔 배포합니다.

```bash
npm run deploy
```

`/api/totp/status`와 `/security`에서 저장 상태를 확인한 다음 bootstrap을 `false`로 되돌려 다시 배포합니다.

## GitHub 자동 배포

`.github/workflows/deploy-worker.yml`은 수동 실행할 때만 새 Worker를 배포합니다. 저장소 Settings의 Actions secrets에 다음 두 값이 필요합니다.

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Worker runtime secrets인 `TOTP_STORE_ENCRYPTION_KEY`, `AUTH_TOKEN_SECRET`, `ADMIN_TOTP_SECRET`은 GitHub에 넣지 않고 Cloudflare Worker 설정에 저장합니다.

시험 주소에서 검증이 끝나기 전에는 `virtual-herbarium.columbina.kr` DNS를 변경하지 않습니다. 최종 전환은 기존 GitHub Pages CNAME을 새 Worker Custom Domain으로 교체하는 별도 단계입니다.

## 보안 경계

이미지 API와 OTP 관리 API는 Worker의 서명 토큰으로 보호됩니다. 하지만 현재 Firestore 쓰기는 브라우저에서 Firebase로 직접 수행되고 `firestore.rules`도 공개 쓰기를 허용합니다. 따라서 브라우저 UI를 우회한 Firestore 직접 변경까지 막으려면 다음 단계에서 데이터 쓰기 API도 Worker로 옮기고 Firestore Rules를 잠가야 합니다.

## 기존 Express 서버

`server.ts`는 마이그레이션 비교와 비상 복구를 위해 그대로 유지했습니다. 다음 명령으로만 기존 Node 서버 빌드를 만들 수 있습니다.

```bash
npm run build:legacy
npm run start:legacy
```
