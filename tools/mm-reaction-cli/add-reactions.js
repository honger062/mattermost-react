/*
  Mattermost Reaction CLI (Node.js, no external deps)
  - Add reactions (including custom emojis) to a post, sequentially and fast
  - Config separated into config.json and emoji-map.json

  Requirements: Node.js >= 16
*/

// [섹션] 기본 모듈 임포트
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// 루트 .env 파일 로드 (선택)
try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch (e) {
  // dotenv 없으면 무시
}

// [섹션] 기본 숫자→이모지 매핑 (mapFile로 재정의 가능)
const DEFAULT_MAP = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

// [유틸] CLI 인자 파서 (--key value | --key=value)
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      const key = k.replace(/^--/, '');
      if (v !== undefined) {
        opts[key] = v;
      } else {
        const next = args[i + 1];
        if (!next || next.startsWith('--')) {
          opts[key] = 'true';
        } else {
          opts[key] = next;
          i++;
        }
      }
    }
  }
  return opts;
}

// [유틸] JSON 안전 로더 (존재 여부 확인 + 예외 로깅)
function safeReadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`WARN: JSON 읽기 실패: ${filePath} -> ${e.message}`);
  }
  return null;
}

// [네트워크] 최소 HTTP/HTTPS 요청 래퍼 (외부 라이브러리 불필요)
function httpRequest(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// [유틸] 인증 헤더 구성 (세션 쿠키 or PAT 토큰)
function buildAuthHeaders(auth = {}) {
  const headers = {};
  const { token, sessionCookie } = auth;
  if (sessionCookie) {
    headers['Cookie'] = sessionCookie;
    // MMCSRF 있으면 CSRF 헤더 추가
    const m = String(sessionCookie).match(/(?:^|;)\s*MMCSRF=([^;]+)/);
    const csrf = m && m[1];
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// [API] 인증 사용자 ID 조회 (/api/v4/users/me)
async function getMyUserId(base, auth) {
  const res = await httpRequest('GET', `${base}/api/v4/users/me`, buildAuthHeaders(auth));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`users/me 실패: ${res.status} ${res.text}`);
  }
  const me = JSON.parse(res.text);
  return me.id;
}

// [유틸] 이모지 이름 정규화 (:name: → name, 공백 제거)
function cleanEmojiName(name) {
  return String(name).trim().replace(/^:|:$/g, '');
}

// [API] 반응 추가 (/api/v4/reactions)
//  - 성공: 201
//  - 중복(이미 있음): 400 포함 메시지이면 경고 후 무시 처리
async function addReaction(base, auth, userId, postId, emojiName) {
  const bodyObj = {
    user_id: userId,
    post_id: postId,
    emoji_name: cleanEmojiName(emojiName),
  };
  const body = JSON.stringify(bodyObj);
  const headers = Object.assign({}, buildAuthHeaders(auth), {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  const res = await httpRequest('POST', `${base}/api/v4/reactions`, headers, body);

  if (res.status === 201) return true;

  // 이미 동일 반응이 있는 경우 400 가능 -> 메시지 확인 후 무시 처리
  if (res.status === 400 && /exist|already/i.test(res.text || '')) {
    console.warn(`중복 반응: ${bodyObj.emoji_name} (무시)`);
    return false;
  }
  throw new Error(`반응 추가 실패(${bodyObj.emoji_name}): ${res.status} ${res.text}`);
}

// [유틸] 지연 도우미 (rate limit 대응)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [파싱] seq 입력 해석 (":name::name2:" 또는 숫자/문자열)
function splitSeq(seq) {
  // ":name::name2:" 형태면 콜론 그룹으로 분리, 아니면 문자단위 분리
  if (/:[^:\s]+:/.test(seq)) {
    const items = seq.match(/:[^:\s]+:/g) || [];
    return items.map((s) => s.replace(/^:|:$/g, ''));
  }
  return seq.split('');
}

// [파싱] --emojis 인자 해석 (콜론 시퀀스 | 콤마/공백 리스트)
function parseEmojisArg(arg) {
  if (!arg) return [];
  // 콜론 포함 시퀀스 전체 문자열 지원
  if (/:[^:\s]+:/.test(arg)) {
    const items = arg.match(/:[^:\s]+:/g) || [];
    return items.map((s) => s.replace(/^:|:$/g, ''));
  }
  // 콤마/공백 구분 리스트 지원
  return String(arg)
    .split(/[\,\s]+/)
    .filter(Boolean)
    .map((s) => s.replace(/^:|:$/g, ''));
}

// [파싱] --emojisFile 파일 읽기 (줄 단위, :name: 허용)
function readEmojisFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^:|:$/g, ''));
  } catch (e) {
    console.warn(`WARN: emojisFile 읽기 실패: ${e.message}`);
    return [];
  }
}

// [매핑] 입력 토큰을 최종 이모지 이름으로 변환
//  1) customMap (emoji-map.json)
//  2) DEFAULT_MAP (0~9 기본값)
//  3) 원본을 정규화하여 사용
function digitToEmojiName(ch, customMap) {
  if (customMap && Object.prototype.hasOwnProperty.call(customMap, ch)) {
    return cleanEmojiName(customMap[ch]);
  }
  if (DEFAULT_MAP[ch]) return DEFAULT_MAP[ch];
  return cleanEmojiName(ch);
}

(async function main() {
  // [메인] 1) 실행 컨텍스트 및 CLI 인자 파싱
  const cwd = __dirname;
  const args = parseArgs();

  // [메인] 2) config.json 로드 (동일 폴더)
  const cfgPath = path.join(cwd, 'config.json');
  const cfg = safeReadJSON(cfgPath) || {};

  // [메인] 2.5) local-config.json 로드 (동일 폴더, 선택)
  const localCfgPath = path.join(cwd, 'local-config.json');
  const local = safeReadJSON(localCfgPath) || {};

  // [메인] 3) 실행 설정 수집 (CLI > local-config > ENV > config)
  const base = args.base || local.baseUrl || process.env.MM_BASE_URL || cfg.base || cfg.baseUrl;
  const token = args.token || local.token || process.env.MM_TOKEN || cfg.token;
  const sessionCookie = args.sessionCookie || local.sessionCookie || process.env.MM_SESSION_COOKIE || cfg.sessionCookie;
  const postId = args.post || local.postId || process.env.MM_POST_ID || cfg.postId;
  const seq = args.seq || process.env.SEQ || cfg.seq;
  const emojisArg = args.emojis || process.env.EMOJIS || cfg.emojisArg;
  const emojisFile = args.emojisFile || process.env.EMOJIS_FILE || cfg.emojisFile;
  const delay = parseInt(String(args.delay || process.env.MM_DELAY_MS || cfg.delayMs || '120'), 10);

  // [메인] 4) 숫자→이모지 매핑 파일 로드 (선택)
  const mapFile = args.mapFile || process.env.MAP_FILE || cfg.mapFile || 'emoji-map.json';
  const mapPath = path.isAbsolute(mapFile) ? mapFile : path.join(cwd, mapFile);
  const customMap = safeReadJSON(mapPath) || {};

  // [메인] 5) 필수 인자 검증 및 사용법
  if (!base || (!token && !sessionCookie) || !postId) {
    console.error(`사용법:
  node add-reactions.js --base <https://your-mm> (--token <PAT> | --sessionCookie "MMAUTHTOKEN=...; MMCSRF=...") --post <POST_ID> --seq <시퀀스>
  [--emojis "thumbsup,heart,my_custom"] [--emojisFile emojis.txt]
  [--mapFile emoji-map.json] [--delay 120]

또는 tools/mm-reaction-cli/config.json 파일을 작성하세요 (README 참고).
`);
    process.exit(1);
  }

  // [메인] 6) Base URL 정규화 (끝 슬래시 제거)
  let baseUrl = base.replace(/\/$/, '');

  const authMode = sessionCookie ? 'sessionCookie' : 'token';
  console.log(`설정: base=${baseUrl}, post=${postId}, delay=${delay}ms, mapFile=${path.basename(mapPath)}, auth=${authMode}`);

  // [메인] 7) 내 사용자 ID 조회
  let userId;
  try {
    userId = await getMyUserId(baseUrl, { token, sessionCookie });
  } catch (e) {
    console.error(`인증/프로필 확인 실패: ${e.message || e}`);
    process.exit(1);
  }

  // [메인] 8) 입력 이모지 목록 구성 (우선순위: config.emojis → emojisFile → --emojis → seq)
  let items = [];
  if (Array.isArray(cfg.emojis) && cfg.emojis.length) {
    items = cfg.emojis.map(cleanEmojiName);
  } else if (emojisFile) {
    const efPath = path.isAbsolute(emojisFile) ? emojisFile : path.join(cwd, emojisFile);
    items = readEmojisFile(efPath);
  } else if (emojisArg) {
    items = parseEmojisArg(emojisArg);
  } else if (seq) {
    items = splitSeq(String(seq));
  }

  // [메인] 9) 입력 검증
  if (!items.length) {
    console.error(`에러: 추가할 이모지 목록이 없습니다. 아래 중 하나를 제공하세요.
  - --seq "0105..." 또는 config.seq
  - --emojis "thumbsup,heart,my_custom" 또는 config.emojis (배열)
  - --emojisFile emojis.txt 또는 config.emojisFile (줄단위 이름)
`);
    process.exit(1);
  }

  console.log(`총 ${items.length}개 반응 추가 시작 (user=${userId})`);

  // [메인] 10) 순차 반응 추가 (지연 적용)
  for (const ch of items) {
    const name = digitToEmojiName(ch, customMap);
    if (!name) {
      console.warn(`매핑 불가: "${ch}" → 스킵`);
      continue;
    }
    try {
      await addReaction(baseUrl, { token, sessionCookie }, userId, postId, name);
      console.log(`OK: ${name}`);
    } catch (e) {
      console.error(e.message || e);
    }
    if (delay > 0) await sleep(delay);
  }

  // [메인] 11) 완료
  console.log('완료');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
