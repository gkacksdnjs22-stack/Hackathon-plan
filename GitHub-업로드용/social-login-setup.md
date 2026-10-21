# 구글·카카오·네이버 로그인 연결

현재는 연결 코드만 준비된 상태입니다. 각 제공자의 로그인용 개발 앱을 만들고 아래 설정을 등록해야 실제 계정으로 로그인할 수 있습니다. 설정이 없는 제공자는 사이트에 버튼을 표시하지 않으며 기존 아이디·비밀번호 로그인은 계속 사용할 수 있습니다.

## 공통 설정

1. 로컬 `.env`에 `SOCIAL_AUTH_BASE_URL=http://localhost:3000`을 입력합니다. 브라우저도 `localhost:3000`으로 접속하세요. `127.0.0.1` 주소와 혼용하면 로그인을 시작할 수 없습니다.
2. Cloudflare 배포 환경에는 `SOCIAL_AUTH_BASE_URL=https://rode-hackathon.pages.dev`를 등록합니다. 이 값은 주소 전체 중 origin만 사용하고, 경로·`#`·쿼리는 붙이지 않습니다. 실제 사용자 도메인으로 바꾸면 콜백 주소도 함께 변경해야 합니다.
3. 아래 제공자별 Client ID·Client Secret을 로컬 `.env`와 Cloudflare의 해당 환경 변수/Secret에 등록합니다. **Client Secret은 Cloudflare Secret으로 등록하고 채팅·GitHub에 올리지 않습니다.** `AUTH_SECRET`과 `DB` 바인딩은 기존 계정 설정을 그대로 사용합니다.
4. 로컬은 서버 시작 시 `account-schema.sql`의 추가 테이블이 자동 생성됩니다. Cloudflare D1은 기존 DB를 유지한 채 `npx wrangler d1 execute <실제 DB 이름> --remote --file=account-schema.sql`로 추가 테이블을 적용합니다. 이 SQL은 `CREATE TABLE IF NOT EXISTS`만 사용하며 기존 사용자·계획을 지우지 않습니다. 배포 전 해당 프로젝트의 DB 이름을 확인하세요.
5. 서버 재시작 또는 새 배포 후 `/api/auth/providers`에 설정한 제공자가 나오는지 확인합니다. 키가 없거나 스키마가 준비되지 않으면 목록이 비어 있습니다. 키 자체는 응답에 포함되지 않습니다.

## Google

[Google Auth Platform](https://console.cloud.google.com/auth/overview)에서 웹 애플리케이션 OAuth 클라이언트를 만듭니다. 동의 화면·테스트 사용자·게시 상태를 서비스에 맞게 설정하고 다음 리디렉션 URI를 등록합니다.

```
http://localhost:3000/api/auth/oauth/google/callback
https://rode-hackathon.pages.dev/api/auth/oauth/google/callback
```

Client ID는 `GOOGLE_CLIENT_ID`, Client Secret은 `GOOGLE_CLIENT_SECRET`에 넣습니다. 이 구현은 로그인 식별에 필요한 `openid`만 요청하며 이메일·연락처·프로필 사진을 수집하지 않습니다. 코드 교환에 PKCE를 사용하고 ID 토큰 서명, 발급자, 대상 클라이언트, 만료, nonce를 서버에서 검증합니다. 설정 상세는 [Google OpenID Connect 문서](https://developers.google.com/identity/openid-connect/openid-connect)를 참고하세요.

## Kakao

[카카오디벨로퍼스](https://developers.kakao.com/console/app)에서 앱을 만들거나 사용할 앱을 선택한 뒤 카카오 로그인을 활성화하고 REST API 키 및 Client Secret을 준비합니다. 이 구현은 Client Secret이 있는 서버 방식을 사용합니다. 다음 Redirect URI를 등록합니다.

```
http://localhost:3000/api/auth/oauth/kakao/callback
https://rode-hackathon.pages.dev/api/auth/oauth/kakao/callback
```

REST API 키는 `KAKAO_LOGIN_CLIENT_ID`, Client Secret은 `KAKAO_LOGIN_CLIENT_SECRET`에 넣습니다. 기존 경로 조회용 `KAKAO_REST_API_KEY`와 로그인 설정은 따로 읽습니다. 사용자 정보의 회원번호만 식별에 사용하며 이메일로 기존 계정을 연결하지 않습니다. 선택한 앱의 카카오 로그인 동의항목·이용 조건도 확인하세요. [공식 REST 로그인 문서](https://developers.kakao.com/docs/ko/kakaologin/rest-api)에 앱 설정과 토큰 교환 방법이 안내되어 있습니다.

## NAVER

[네이버 애플리케이션 등록](https://developers.naver.com/apps/#/register)에서 네이버 로그인을 신청하고 서비스 URL과 다음 Callback URL을 등록합니다.

```
http://localhost:3000/api/auth/oauth/naver/callback
https://rode-hackathon.pages.dev/api/auth/oauth/naver/callback
```

Client ID는 `NAVER_CLIENT_ID`, Client Secret은 `NAVER_CLIENT_SECRET`에 넣습니다. 별도 서비스/테스트 환경 앱으로 관리해도 됩니다. 서비스 공개에 필요한 검수와 이용자 범위는 개발자 센터에서 확인하세요. 이 구현은 프로필 응답의 동일인 식별 정보 `id`만 사용하고 다른 프로필 항목은 저장하지 않습니다. [인증 API 문서](https://developers.naver.com/docs/login/api/api.md)와 [프로필 API 문서](https://developers.naver.com/docs/login/profile/profile.md)를 참고하세요.

## 계정과 계획의 분리

소셜 로그인은 **제공자 + 제공자가 검증한 사용자 식별자**로 별도 계정을 만듭니다. 같은 이메일의 기존 아이디 계정이나 다른 소셜 계정을 자동으로 합치지 않습니다. 따라서 기존 아이디로 저장한 노트는 그 아이디로 로그인해야 보입니다. 계정 연결 기능은 포함하지 않습니다.

식별자는 `AUTH_SECRET`으로 HMAC 처리해 DB에 저장하고, 제공자의 접근·갱신 토큰은 저장하지 않습니다. 일회용 로그인 상태는 10분 만료이며 브라우저 전용 HttpOnly 쿠키와 함께 검증한 뒤 한 번만 소비합니다. `AUTH_SECRET`을 바꾸면 기존 비밀번호뿐 아니라 소셜 계정 식별도 유지되지 않으므로 기존 비밀값을 보관해야 합니다. 사이트 로그아웃은 사이트 세션만 종료하며 Google·Kakao·NAVER 자체 계정에서는 로그아웃하지 않습니다.

현재 자동 검증은 외부 인증 서버를 모의한 테스트입니다. 개발 앱 등록·실제 키 연결 후에는 제공자별 로그인/동의 취소/다른 계정 로그인/로그아웃/다른 계정 노트 차단을 실제 브라우저에서 확인해야 합니다.
