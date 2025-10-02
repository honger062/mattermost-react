// Mattermost Reaction Web - Express proxy + static UI
// 로컬 개발/개인 사용을 전제로 하며, 토큰은 요청마다 전달되고 서버에 저장하지 않습니다.

const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

// 루트 .env 파일 로드 (선택)
try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch (e) {
  // dotenv 없으면 무시
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// 간단한 에러 응답 헬퍼
function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// ===== 전역 검색 인덱스 (메모리 캐시) =====
// 캐시 키: baseUrl(정규화)
const emojiIndexCache = new Map(); // key -> { list: Array<{id,name,lower}>, builtAt: number }
const INDEX_TTL_MS = 15 * 60 * 1000; // 15분 TTL

async function buildEmojiIndex(base, sessionCookie, forceRebuild = false) {
  const key = base;
  if (emojiIndexCache.has(key) && !forceRebuild) {
    const cached = emojiIndexCache.get(key);
    if (cached && cached.list && Array.isArray(cached.list) && (Date.now() - cached.builtAt) < INDEX_TTL_MS) {
      return cached.list;
    }
  }
  const list = [];
  // 인덱스 구축: 큰 페이지 사이즈로 반복 호출(이름/ID만 보관)
  let page = 0;
  const perPage = 200;
  while (true) {
    const urlSorted = `${base}/api/v4/emoji?page=${page}&per_page=${perPage}&sort=name`;
    const urlPlain = `${base}/api/v4/emoji?page=${page}&per_page=${perPage}`;
    let r = await httpRequest('GET', urlSorted, buildAuthHeaders(sessionCookie));
    if (r.status < 200 || r.status >= 300) {
      // 일부 서버가 sort 파라미터를 지원하지 않을 수 있어 폴백
      const r2 = await httpRequest('GET', urlPlain, buildAuthHeaders(sessionCookie));
      if (r2.status < 200 || r2.status >= 300) {
        throw new Error(`이모지 인덱스 구축 실패: ${r.status} ${r.text}`);
      }
      r = r2;
    }
    const arr = JSON.parse(r.text);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const it of arr) {
      if (it && it.name && it.id) {
        const name = String(it.name);
        list.push({ id: String(it.id), name, lower: name.toLowerCase() });
      }
    }
    if (arr.length < perPage) break;
    page += 1;
    if (page > 200) break; // 안전 장치
  }
  emojiIndexCache.set(key, { list, builtAt: Date.now() });
  return list;
}

function normalizeBase(baseUrl) {
  if (!baseUrl) return '';
  return baseUrl.replace(/\/$/, '');
}

// 인증 헤더 빌더: sessionCookie(Cookie) 전용
function buildAuthHeaders(sessionCookie) {
  const headers = {};
  if (sessionCookie) {
    headers.Cookie = sessionCookie; // 예: "MMAUTHTOKEN=...; MMCSRF=..."
    // MMCSRF 쿠키가 있으면 헤더로 전달(브라우저 CSRF 보호 회피 필요 시)
    const m = /(?:^|;\s*)MMCSRF=([^;]+)/.exec(sessionCookie);
    if (m && m[1]) {
      headers['X-CSRF-Token'] = decodeURIComponent(m[1]);
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
  }
  return headers;
}

// 텍스트 응답용 HTTP/HTTPS 요청 래퍼
function httpRequest(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    try {
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
      if (body) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Set-Cookie 배열에서 name=value 페어만 추출
function extractCookieMap(setCookieHeader) {
  const map = {};
  if (!setCookieHeader) return map;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of arr) {
    const first = String(raw || '').split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) {
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      map[name] = value;
    }
  }
  return map;
}

// 이미지 스트리밍용 프록시(파이프)
function pipeUpstream(res, method, urlStr, headers = {}) {
  try {
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
    const up = client.request(options, (upRes) => {
      res.status(upRes.statusCode || 500);
      // 원본 콘텐츠 타입 유지 시도
      if (upRes.headers['content-type']) {
        res.set('Content-Type', upRes.headers['content-type']);
      }
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      sendError(res, 502, `Upstream error: ${err.message}`);
    });
    up.end();
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

function cleanEmojiName(name) {
  return String(name || '').trim().replace(/^:+|:+$/g, '');
}

async function getMyUserId(base, sessionCookie) {
  const res = await httpRequest('GET', `${base}/api/v4/users/me`, buildAuthHeaders(sessionCookie));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`users/me 실패: ${res.status} ${res.text}`);
  }
  const me = JSON.parse(res.text);
  return me.id;
}

// 1) 이모지 목록 로딩(페이지네이션)
app.post('/api/emoji/list', async (req, res) => {
  try {
    const { baseUrl, sessionCookie, perPage = 200, page } = req.body || {};
    if (!baseUrl || !sessionCookie) return sendError(res, 400, 'baseUrl과 sessionCookie가 필요합니다.');
    const base = normalizeBase(baseUrl);

    // 단일 페이지 요청이 명시된 경우: 해당 페이지만 반환
    if (page !== undefined && page !== null) {
      const p = Math.max(0, Number(page) || 0);
      const pp = Math.max(1, Math.min(1000, Number(perPage) || 200));
      const url = `${base}/api/v4/emoji?page=${p}&per_page=${pp}&sort=name`;
      const r = await httpRequest('GET', url, buildAuthHeaders(sessionCookie));
      if (r.status < 200 || r.status >= 300) {
        return sendError(res, r.status, `이모지 목록 조회 실패: ${r.status} ${r.text}`);
      }
      const arr = JSON.parse(r.text);
      const items = Array.isArray(arr) ? arr : [];
      const hasMore = items.length === pp; // 다음 페이지가 있을 가능성
      return res.json({ count: items.length, items, page: p, perPage: pp, hasMore });
    }

    // 기존 동작: 모든 페이지를 합쳐 반환(주의: 대량 데이터시 브라우저 부하)
    const all = [];
    let pageIdx = 0;
    const pp = Math.max(1, Math.min(1000, Number(perPage) || 200));
    while (true) {
      const url = `${base}/api/v4/emoji?page=${pageIdx}&per_page=${pp}&sort=name`;
      const r = await httpRequest('GET', url, buildAuthHeaders(sessionCookie));
      if (r.status < 200 || r.status >= 300) {
        return sendError(res, r.status, `이모지 목록 조회 실패: ${r.status} ${r.text}`);
      }
      const arr = JSON.parse(r.text);
      if (!Array.isArray(arr) || arr.length === 0) break;
      all.push(...arr);
      if (arr.length < pp) break;
      pageIdx += 1;
      if (pageIdx > 200) break; // 안전 장치
    }
    res.json({ count: all.length, items: all });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// 2) 이모지 이미지 스트림
app.get('/api/emoji/image/:id', (req, res) => {
  const { id } = req.params;
  const { baseUrl, sessionCookie } = req.query;
  if (!id || !baseUrl || !sessionCookie) return sendError(res, 400, 'id, baseUrl과 sessionCookie가 필요합니다.');
  const base = normalizeBase(String(baseUrl));
  const url = `${base}/api/v4/emoji/${encodeURIComponent(id)}/image`;
  pipeUpstream(res, 'GET', url, buildAuthHeaders(sessionCookie));
});

// 2-1) 전역 이모지 검색 (인덱스 기반, 부분 일치)
app.post('/api/emoji/search', async (req, res) => {
  try {
    const { baseUrl, sessionCookie, query, limit = 200, offset = 0, rebuild = false } = req.body || {};
    if (!baseUrl || !sessionCookie) return sendError(res, 400, 'baseUrl과 sessionCookie가 필요합니다.');
    // 검색어 정규화: 앞뒤 콜론(:) 제거 (예: :smile: -> smile)
    const rawQ = String(query || '').trim();
    const q = rawQ.replace(/^:+|:+$/g, '');
    if (!q) return res.json({ total: 0, count: 0, items: [] });
    const base = normalizeBase(baseUrl);
    const list = await buildEmojiIndex(base, sessionCookie, Boolean(rebuild));
    const ql = q.toLowerCase();
    const max = Math.max(1, Math.min(2000, Number(limit) || 200));
    const off = Math.max(0, Number(offset) || 0);

    const exact = [];
    const prefix = [];
    const substr = [];
    for (const it of list) {
      const nm = it.lower;
      if (nm === ql) {
        exact.push({ id: it.id, name: it.name });
      } else if (nm.startsWith(ql)) {
        prefix.push({ id: it.id, name: it.name });
      } else if (nm.includes(ql)) {
        substr.push({ id: it.id, name: it.name });
      }
    }
    // 그룹 내 정렬: 이름 오름차순
    exact.sort((a, b) => a.name.localeCompare(b.name));
    prefix.sort((a, b) => a.name.localeCompare(b.name));
    substr.sort((a, b) => a.name.localeCompare(b.name));

    const combined = exact.concat(prefix, substr);
    const total = combined.length;
    const items = combined.slice(off, off + max);
    res.json({ total, count: items.length, items, truncated: total > (off + items.length), offset: off, limit: max });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// 2-2) 전역 이모지 인덱스 재구축(강제)
app.post('/api/emoji/reindex', async (req, res) => {
  try {
    const { baseUrl, sessionCookie } = req.body || {};
    if (!baseUrl || !sessionCookie) return sendError(res, 400, 'baseUrl과 sessionCookie가 필요합니다.');
    const base = normalizeBase(baseUrl);
    const list = await buildEmojiIndex(base, sessionCookie, true);
    res.json({ rebuilt: true, count: list.length });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// 3) 일괄 반응 전송(순차, 딜레이, 중복 무시)
app.post('/api/reactions/bulk', async (req, res) => {
  try {
    const { baseUrl, sessionCookie, postId, emojis, delayMs = 300 } = req.body || {};
    if (!baseUrl || !sessionCookie || !postId || !Array.isArray(emojis)) {
      return sendError(res, 400, 'baseUrl, sessionCookie, postId, emojis[]가 필요합니다.');
    }
    const base = normalizeBase(baseUrl);

    const userId = await getMyUserId(base, sessionCookie);

    const results = [];
    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const raw of emojis) {
      const emojiName = cleanEmojiName(raw);
      const payload = JSON.stringify({ user_id: userId, post_id: postId, emoji_name: emojiName });
      const authHeaders = buildAuthHeaders(sessionCookie);
      const r = await httpRequest('POST', `${base}/api/v4/reactions`, { ...authHeaders, 'Content-Type': 'application/json' }, payload);

      // 2xx는 성공으로 간주 (서버별 200/201 차이 흡수)
      if (r.status >= 200 && r.status < 300) {
        success += 1;
        results.push({ emoji: emojiName, status: r.status, ok: true });
      } else {
        // 400/409 등에서 "이미 존재"(중복) 케이스 판별 - 다국어/다양한 문구 대응
        let bodyText = String(r.text || '');
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && typeof parsed === 'object' && parsed.message) {
            bodyText = String(parsed.message);
          }
        } catch (_) { /* ignore JSON parse errors */ }

        const isDupStatus = r.status === 400 || r.status === 409;
        const isDupMsg = /(already\s*exists|duplicate|exists|이미|중복|존재)/i.test(bodyText);
        if (isDupStatus && isDupMsg) {
          skipped += 1;
          results.push({ emoji: emojiName, status: r.status, ok: true, skipped: true, msg: 'duplicate' });
        } else {
          failed += 1;
          results.push({ emoji: emojiName, status: r.status, ok: false, msg: r.text });
        }
      }

      // 딜레이
      if (delayMs && Number(delayMs) > 0) {
        await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
      }
    }

    res.json({ total: emojis.length, success, skipped, failed, results });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// 로컬 설정 반환: 환경변수 > local-config.json 순서로 읽기
app.get('/api/local-config', (req, res) => {
  try {
    let baseUrl = process.env.MM_BASE_URL || '';
    let sessionCookie = process.env.MM_SESSION_COOKIE || '';
    
    // local-config.json이 있으면 우선 적용
    const cfgPath = path.join(__dirname, 'local-config.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      baseUrl = parsed.baseUrl || baseUrl;
      sessionCookie = parsed.sessionCookie || sessionCookie;
    }
    
    return res.json({
      baseUrl: String(baseUrl),
      sessionCookie: String(sessionCookie),
    });
  } catch (e) {
    return res.json({ 
      baseUrl: process.env.MM_BASE_URL || '', 
      sessionCookie: process.env.MM_SESSION_COOKIE || '' 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ===== 프리셋 저장/불러오기 (로컬 JSON 파일) =====
const PRESETS_PATH = path.join(__dirname, 'presets.json');

function readPresetsFile() {
  try {
    if (!fs.existsSync(PRESETS_PATH)) return { presets: {} };
    const raw = fs.readFileSync(PRESETS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return { presets: {} };
    const p = parsed.presets && typeof parsed.presets === 'object' ? parsed.presets : {};
    return { presets: p };
  } catch (_) {
    return { presets: {} };
  }
}

function writePresetsFile(data) {
  try {
    const payload = { presets: data.presets || {} };
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

// 목록: { names: [{name, count}] }
app.get('/api/presets', (req, res) => {
  const data = readPresetsFile();
  const names = Object.keys(data.presets).sort().map((name) => ({ name, count: Array.isArray(data.presets[name]) ? data.presets[name].length : 0 }));
  res.json({ names });
});

// 단일 프리셋 조회
app.get('/api/presets/:name', (req, res) => {
  const { name } = req.params;
  const key = String(name || '').trim();
  if (!key) return sendError(res, 400, 'name이 필요합니다.');
  const data = readPresetsFile();
  const arr = data.presets[key];
  if (!arr) return sendError(res, 404, '프리셋이 없습니다.');
  res.json({ name: key, emojis: Array.isArray(arr) ? arr : [] });
});

// 저장/업데이트: { name, emojis[] }
app.post('/api/presets', (req, res) => {
  try {
    const { name, emojis } = req.body || {};
    const key = String(name || '').trim();
    if (!key) return sendError(res, 400, 'name이 필요합니다.');
    if (!Array.isArray(emojis)) return sendError(res, 400, 'emojis[] 배열이 필요합니다.');
    // 이모지 이름 정규화 및 필터링
    const cleaned = emojis.map((x) => cleanEmojiName(x)).filter((x) => !!x);
    const data = readPresetsFile();
    data.presets[key] = cleaned;
    if (!writePresetsFile(data)) return sendError(res, 500, '프리셋 저장 실패');
    res.json({ ok: true, name: key, count: cleaned.length });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

// 삭제
app.delete('/api/presets/:name', (req, res) => {
  try {
    const { name } = req.params;
    const key = String(name || '').trim();
    if (!key) return sendError(res, 400, 'name이 필요합니다.');
    const data = readPresetsFile();
    if (data.presets[key]) {
      delete data.presets[key];
      if (!writePresetsFile(data)) return sendError(res, 500, '프리셋 삭제 실패');
    }
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`Mattermost Reaction Web running at http://localhost:${PORT}`);
});
