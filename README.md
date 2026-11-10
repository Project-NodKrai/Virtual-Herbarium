# Virtual Herbarium_TEST

React, Firestore, Cloudflare Workers, R2, Workers KV, TOTP를 사용하는 가상 식물표본관입니다.

## Cloudflare 구성

- React 결과물은 Workers Static Assets로 제공합니다.
- `/api/*` 요청만 `worker/index.ts`가 처리합니다.
- 이미지는 `HERBARIUM_BUCKET` R2 바인딩을 통해 `virtual-herbarium` 버킷에 저장합니다.
- OTP 사용자 목록은 `OTP_STATE` KV에 AES-256-GCM 암호문으로 저장합니다.
- OTP 검증에 성공하면 5분짜리 서명 토큰을 발급합니다. 표본 저장·삭제, 이미지 업로드·삭제와 OTP 관리 API는 이 토큰을 확인합니다.
- 표본 조회는 Firestore SDK로 직접 수행하고, 쓰기는 Worker의 `/api/records/INCH-PT00000` 형태의 API를 거칩니다.
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
npm test
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
- 운영 Custom Domain: `virtual-herbarium.columbina.kr`

이 프로젝트만 사용하는 `virtual-herbarium-test-otp-state` KV가 별도로 연결되어 있습니다. 배포 대상은 이 Worker와 위 Custom Domain뿐입니다.

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

운영 Worker에는 GitHub `main`의 Cloudflare Workers Builds 연결이 있습니다. 별도의 `.github/workflows/deploy-worker.yml`도 `main` push 또는 수동 실행 시 배포를 시도하며, 이 경로에는 저장소 Settings의 Actions secrets 두 값이 필요합니다.

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Worker runtime secrets인 `TOTP_STORE_ENCRYPTION_KEY`, `AUTH_TOKEN_SECRET`, `ADMIN_TOTP_SECRET`, `FIREBASE_SERVICE_ACCOUNT`는 GitHub에 넣지 않고 Cloudflare Worker 설정에 저장합니다.

`virtual-herbarium.columbina.kr`은 현재 Worker Custom Domain으로 연결되어 있습니다. 다른 Worker 또는 도메인의 설정을 변경하지 않습니다.

## 표본 저장 서버 인증

표본 수정에서 OTP가 통과한 뒤 `Missing or insufficient permissions`가 발생했던 원인은 브라우저가 Firebase 인증 없이 직접 쓰기를 시도했기 때문입니다. 새 Worker API에는 Google 서버 인증이 필요합니다. 이 설정이 없으면 표본 저장·삭제는 설명이 포함된 503 응답으로 중단됩니다.

프로젝트 소유자가 다음 구성을 준비해야 합니다.

현재 운영 Google 프로젝트는 AI Studio Starter 등급입니다. 이 유형은 Google이 IAM과 조직 정책을 관리하므로 로그인 계정에 서비스 계정 생성·키 발급 권한이 없습니다. [Starter Tier 공식 안내](https://docs.cloud.google.com/docs/starter-tier#upgrade-your-starter-tier-project)에 따르면 일반 프로젝트로의 전환은 결제 계정 연결 및 약관 동의를 요구합니다. 같은 프로젝트에 다른 앱의 데이터베이스도 있으므로 전환 시 이들의 비용·관리 범위까지 고려해야 합니다. 이 저장소의 변경은 프로젝트 전환, 결제 연결, IAM 변경을 수행하지 않습니다.

1. Google 프로젝트 `hypnagogic-charmer-8cf5x`에 가상표본관 전용 서비스 계정을 만듭니다. 다른 앱이 공유하는 기본 Admin SDK 계정을 사용하지 않습니다.
2. `roles/datastore.user`를 다음 IAM 조건으로 제한합니다. 다른 AI Studio 데이터베이스에는 권한을 부여하지 않습니다.

   ```text
   resource.name == "projects/hypnagogic-charmer-8cf5x/databases/ai-studio-virtualherbarium-457a0c18-aee3-4c39-ac7f-d22db488f2e4"
   ```

3. 이 서비스 계정의 JSON 키 전체를 `virtual-herbarium-test` Worker의 암호화된 Secret `FIREBASE_SERVICE_ACCOUNT`로 저장합니다. 저장소, 프런트엔드 환경 변수 또는 채팅에 키를 넣지 않습니다.
4. 배포 후 기존 표본을 동일한 값으로 저장해 성공 응답과 재조회 결과를 확인합니다.

Worker는 프로젝트, named database, `records` 컬렉션을 코드에서 고정합니다. 다른 프로젝트의 키와 임의 문서 경로는 거부합니다. IAM 조건 설정은 [Firestore 데이터베이스 액세스 권한 구성](https://firebase.google.com/docs/firestore/manage-databases#configure_per-database_access_permissions), 서버 인증은 [서비스 계정 OAuth 문서](https://developers.google.com/identity/protocols/oauth2/service-account)를 참고하세요.

## 보안 경계

표본·이미지 쓰기 API와 OTP 관리 API는 Worker의 서명 토큰으로 보호됩니다. Firestore REST 쓰기는 서비스 계정 IAM으로 인증하며, 일반 브라우저의 쓰기는 Firestore Rules가 제한합니다.

현재 운영 Rules는 인증된 `editor`/`admin` 클레임을 요구합니다. 저장소의 Rules도 이에 맞춰 유지합니다. 이 저장소에는 Firebase Rules 자동 배포 설정이 없으며, 공유 Google 프로젝트 전체에 Rules를 배포하면 안 됩니다. 공개 쓰기로 Rules를 완화해서 OTP 저장 오류를 해결하지 않습니다.

## 기존 Express 서버

`server.ts`는 마이그레이션 비교와 비상 복구를 위해 그대로 유지했습니다. 다음 명령으로만 기존 Node 서버 빌드를 만들 수 있습니다.

```bash
npm run build:legacy
npm run start:legacy
```
