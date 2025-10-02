# Mattermost Reaction Tools

Mattermost 게시글에 커스텀 이모지 반응을 일괄 추가하는 도구 모음입니다.

## 프로젝트 구조

```
mm_ex1/
├── .env                      # 공통 환경변수 (gitignore)
├── .env.example              # 환경변수 예시
├── .gitignore                # Git 제외 파일
└── tools/
    ├── mm-reaction-cli/      # CLI 도구
    └── mm-reaction-web/      # 웹 UI 도구
```

## 환경변수 설정 (선택)

루트에 `.env` 파일을 생성하여 공통 설정을 관리할 수 있습니다:

```bash
# .env.example을 .env로 복사
cp .env.example .env
```

### 환경변수 목록

```bash
# Mattermost 서버 URL
MM_BASE_URL=https://your-mattermost.example.com

# Personal Access Token (선택)
MM_TOKEN=your_personal_access_token_here

# 세션 쿠키 (선택, PAT 대신 사용 가능)
MM_SESSION_COOKIE=MMAUTHTOKEN=...; MMCSRF=...

# 기본 포스트 ID (선택)
MM_POST_ID=

# 기본 딜레이 (ms, 선택)
MM_DELAY_MS=120
```

## 설정 우선순위

각 도구는 다음 순서로 설정을 읽습니다:

1. **CLI 인자** (최우선)
2. **local-config.json** (각 도구 디렉토리)
3. **환경변수** (루트 `.env`)
4. **config.json** (각 도구 디렉토리)

## 도구별 사용법

### 1. CLI 도구
```bash
cd tools/mm-reaction-cli
npm install
node add-reactions.js
```

자세한 내용은 `tools/mm-reaction-cli/README.md` 참조

### 2. 웹 UI 도구
```bash
cd tools/mm-reaction-web
npm install
npm start
```

브라우저에서 http://localhost:5174 접속

자세한 내용은 `tools/mm-reaction-web/README.md` 참조

## 의존성 설치

### 전체 설치
```bash
# Web UI
npm --prefix tools/mm-reaction-web install

# CLI
npm --prefix tools/mm-reaction-cli install
```

