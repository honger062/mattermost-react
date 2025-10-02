# Mattermost Reaction Web

로컬 웹 UI로 Mattermost 커스텀 이모지를 불러오고, 선택하여 특정 Post ID로 연속 반응(이모지)을 전송합니다.
백엔드는 Express 프록시로 CORS를 해결하며, 인증은 다음 2가지를 지원합니다.

- Personal Access Token(PAT)
- 세션 기반 로그인(아이디/비밀번호 → 세션 쿠키 사용)

## 설치 / 실행
1) 의존성 설치
```
npm --prefix tools/mm-reaction-web install
```
2) 서버 실행
```
npm --prefix tools/mm-reaction-web start
```
브라우저에서 http://localhost:5174 접속

## 사용법
옵션 A: PAT 사용
1) Base URL, Token(PAT), Post ID 입력
2) "이모지 불러오기"로 커스텀 이모지 목록 로드(이미지 포함)
3) 원하는 이모지를 다중 선택 후 "선택 이모지 반응 보내기" 클릭

옵션 B: 세션 로그인 사용(PAT 불가 환경)
1) Base URL, Login ID, Password 입력 후 "로그인(세션 발급)" 클릭
2) 로그인 성공 시 Session Cookie 입력칸이 자동 채워짐(MMAUTHTOKEN[+MMCSRF])
3) "이모지 불러오기" → 이모지 선택 → "선택 이모지 반응 보내기"

## 엔드포인트(백엔드)
- POST `/api/auth/login`
  - Req: `{ baseUrl, loginId, password }`
  - Res: `{ ok, user, cookies: {MMAUTHTOKEN, MMCSRF?}, cookieHeader }`

- POST `/api/emoji/list`
  - Req: `{ baseUrl, token? , sessionCookie?, perPage? }`
  - Note: `token` 또는 `sessionCookie` 중 하나 필수

- GET `/api/emoji/image/:id`
  - QS: `?baseUrl=...&token=...` 또는 `?baseUrl=...&sessionCookie=...`

- POST `/api/reactions/bulk`
  - Req: `{ baseUrl, token? , sessionCookie?, postId, emojis[], delayMs? }`
  - Note: `token` 또는 `sessionCookie` 중 하나 필수

## 주의사항
- 이 도구는 로컬/내부 사용을 권장합니다. 토큰/세션 쿠키는 요청마다 전달되며 서버에 저장하지 않습니다.
- 조직 SSO 정책에 따라 `/users/login`이 차단될 수 있습니다(이 경우 브라우저에서 직접 세션 쿠키를 복사해 Session Cookie 칸에 붙여넣어 사용 가능).
- 표준(유니코드) 이모지는 API 목록에 포함되지 않으며, reactions 호출 시 `emoji_name`에 짧은 이름을 사용하면 됩니다.
- 중복 반응은 자동으로 건너뜁니다.
