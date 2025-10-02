const $ = (sel) => document.querySelector(sel);

const state = {
  items: [], // {id, name}
  filtered: [],
  selectedQueue: [], // ['emoji_name', ...] 순서 유지, 중복 허용
  baseUrl: '',
  sessionCookie: '', // e.g., "MMAUTHTOKEN=...; MMCSRF=..."
  nameToId: new Map(),
  nameToIdAll: new Map(),
  page: 0,
  perPage: 200,
  hasMore: false,
  // 전역 검색 상태
  searchMode: false,
  searchTerm: '',
  searchResults: [],
  searchTotal: 0,
  searchTruncated: false,
  searchTimer: 0,
  searchOffset: 0,
  searchLimit: 400,
  searchLoading: false,
};

function log(msg) {
  const pre = $('#log');
  pre.textContent += `${msg}\n`;
  pre.scrollTop = pre.scrollHeight;
}

// 선택 로그 출력
function selLog(msg) {
  const pre = document.getElementById('selectLog');
  if (!pre) return;
  pre.textContent += `${msg}\n`;
  pre.scrollTop = pre.scrollHeight;
}

function renderGrid(list) {
  const grid = $('#emojiGrid');
  grid.innerHTML = '';
  const baseUrl = state.baseUrl;
  const sessionCookie = state.sessionCookie;

  for (const item of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    const authQS = `sessionCookie=${encodeURIComponent(sessionCookie)}`;
    img.src = `/api/emoji/image/${encodeURIComponent(item.id)}?baseUrl=${encodeURIComponent(baseUrl)}&${authQS}`;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    const addBtn = document.createElement('button');
    addBtn.textContent = '추가';
    addBtn.addEventListener('click', () => addToQueue(item.name));

    card.appendChild(img);
    card.appendChild(name);
    card.appendChild(addBtn);
    grid.appendChild(card);
  }
  const ec = document.getElementById('emojiCount');
  if (ec) {
    if (state.searchMode) {
      const start = state.searchTotal ? (state.searchOffset + 1) : 0;
      const end = state.searchOffset + list.length;
      ec.textContent = `검색 ${start}-${end}/${state.searchTotal}${state.searchTruncated ? ' (상위만 표시)' : ''}`;
    } else {
      ec.textContent = `이 페이지 ${list.length}개`;
    }
  }
}

function filterList() {
  const term = ($('#search').value || '').toLowerCase();
  if (!term) {
    state.filtered = state.items.slice();
  } else {
    state.filtered = state.items.filter((x) => x.name.toLowerCase().includes(term));
  }
  renderGrid(state.filtered);
}

function setSearchStatus(msg) {
  const el = document.getElementById('searchStatus');
  if (el) el.textContent = msg || '';
}

async function globalSearch(q, opts = {}) {
  state.searchTerm = q;
  if (!state.baseUrl || !state.sessionCookie) {
    alert('먼저 Base URL과 Session Cookie를 입력하고 이모지를 불러오세요.');
    return;
  }
  try {
    state.searchLoading = true;
    setSearchStatus('검색 중...');
    const btn = document.getElementById('searchBtn');
    if (btn) btn.disabled = true;
    const offset = typeof opts.offset === 'number' ? Math.max(0, opts.offset) : state.searchOffset;
    const rebuild = Boolean(opts.rebuild);
    const res = await fetch('/api/emoji/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: state.baseUrl, sessionCookie: state.sessionCookie, query: q, limit: state.searchLimit, offset, rebuild })
    });
    if (!res.ok) {
      const t = await res.text();
      log(`전역 검색 실패: ${res.status} ${t}`);
      setSearchStatus('검색 실패');
      return;
    }
    const data = await res.json();
    state.searchMode = true;
    state.searchResults = (data.items || []).map(e => ({ id: e.id, name: e.name }));
    state.searchTotal = Number(data.total || state.searchResults.length);
    state.searchTruncated = Boolean(data.truncated);
    state.searchOffset = Number(data.offset || offset || 0);
    state.searchLimit = Number(data.limit || state.searchLimit);
    // 전역 캐시 업데이트
    for (const it of state.searchResults) state.nameToIdAll.set(it.name, it.id);
    renderGrid(state.searchResults);
    updatePageInfo();
    const start = state.searchTotal ? (state.searchOffset + 1) : 0;
    const end = state.searchOffset + state.searchResults.length;
    log(`전역 검색 결과: ${start}-${end}/${state.searchTotal}${state.searchTruncated ? ' (상위만 표시)' : ''}`);
  } catch (e) {
    log(`전역 검색 예외: ${e.message}`);
  } finally {
    state.searchLoading = false;
    setSearchStatus('');
    const btn = document.getElementById('searchBtn');
    if (btn) btn.disabled = false;
  }
}

function onSearchInput() {
  const raw = ($('#search').value || '').trim();
  const q = raw.replace(/^:+|:+$/g, '');
  if (!q) {
    state.searchMode = false;
    state.searchTerm = '';
    state.searchResults = [];
    state.searchTotal = 0;
    state.searchTruncated = false;
    state.searchOffset = 0;
    filterList();
    updatePageInfo();
    return;
  }
  if (state.searchTimer) clearTimeout(state.searchTimer);
  // 버튼 클릭 시 즉시 전역 검색 실행
  state.searchOffset = 0;
  globalSearch(q, { offset: 0 });
}

async function loadEmojis() {
  state.baseUrl = $('#baseUrl').value.trim().replace(/\/$/, '');
  state.sessionCookie = $('#sessionCookie').value.trim();
  if (!state.baseUrl || !state.sessionCookie) {
    alert('Base URL과 Session Cookie를 입력하세요.');
    return;
  }
  // perPage 입력 반영 및 첫 페이지부터 로드
  state.perPage = readPerPage();
  state.selectedQueue = [];
  renderSelected();
  await fetchPage(0);
  selLog('이모지 목록을 새로 불러와 선택을 초기화했습니다.');
}

function readPerPage() {
  const el = document.getElementById('perPage');
  const v = Math.max(20, Math.min(1000, Number(el && el.value ? el.value : state.perPage) || state.perPage));
  if (el) el.value = String(v);
  return v;
}

function updatePageInfo() {
  const info = document.getElementById('pageInfo');
  if (info) {
    if (state.searchMode) {
      const start = state.searchTotal ? (state.searchOffset + 1) : 0;
      const end = state.searchOffset + state.searchResults.length;
      info.textContent = `전역 검색: "${state.searchTerm}" (${start}-${end}/${state.searchTotal})`;
    } else {
      info.textContent = `페이지 ${state.page + 1} (perPage ${state.perPage})`;
    }
  }
  const prev = document.getElementById('prevPageBtn');
  const next = document.getElementById('nextPageBtn');
  if (state.searchMode) {
    const hasPrev = state.searchOffset > 0;
    const hasNext = (state.searchOffset + state.searchResults.length) < state.searchTotal;
    if (prev) prev.disabled = !hasPrev;
    if (next) next.disabled = !hasNext;
  } else {
    if (prev) prev.disabled = false;
    if (next) next.disabled = !state.hasMore;
  }
}

// 퍼멀링크/URL에서 postId 추출 또는 원시 ID 정규화
function normalizePostId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    // URL로 파싱 가능한 경우 마지막 세그먼트에서 26자 ID 추출
    const u = new URL(raw);
    const segs = u.pathname.split('/').filter(Boolean);
    // Mattermost permalink는 보통 /.../pl/{postId}
    const last = segs[segs.length - 1] || '';
    const m = last.match(/[a-z0-9]{26}/i);
    if (m) return m[0];
  } catch (_) {
    // URL이 아니면 그대로 검증
  }
  const m2 = raw.match(/[a-z0-9]{26}/i);
  return m2 ? m2[0] : raw;
}

// 버튼 클릭 시 클립보드에서 텍스트를 읽어 Post ID 칸에 붙여넣기
async function pastePostIdFromClipboard() {
  try {
    let text = '';
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    } else {
      // 일부 브라우저/환경에서 clipboard API 미지원 시 대체 입력
      text = prompt('클립보드 읽기 권한이 없어 직접 붙여넣기 해주세요:', '') || '';
    }
    const id = normalizePostId(text);
    const input = document.getElementById('postId');
    if (input) input.value = id;
    if (id) {
      log('클립보드에서 Post ID를 붙여넣었습니다.');
    } else {
      log('클립보드 내용이 비어있거나 유효하지 않습니다.');
    }
  } catch (e) {
    alert('클립보드 접근 실패: 브라우저 권한을 확인하세요.');
  }
}

async function fetchPage(p) {
  const page = Math.max(0, Number(p) || 0);
  const perPage = readPerPage();
  log(`페이지 로딩 중... page=${page}, perPage=${perPage}`);
  const res = await fetch('/api/emoji/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: state.baseUrl, sessionCookie: state.sessionCookie, page, perPage }),
  });
  if (!res.ok) {
    const t = await res.text();
    log(`목록 실패: ${res.status} ${t}`);
    return;
  }
  const data = await res.json();
  state.page = Number(data.page ?? page);
  state.perPage = Number(data.perPage ?? perPage);
  state.hasMore = Boolean(data.hasMore);
  state.items = (data.items || []).map((e) => ({ id: e.id, name: e.name }));
  state.nameToId = new Map(state.items.map((e) => [e.name, e.id]));
  // 전역 캐시 업데이트(페이지 간 유지)
  for (const it of state.items) {
    state.nameToIdAll.set(it.name, it.id);
  }
  filterList();
  updatePageInfo();
  log(`페이지 ${state.page + 1} 로드: ${state.items.length}개${state.hasMore ? ' (다음 페이지 있음)' : ''}`);
}

async function sendReactions() {
  const postId = normalizePostId($('#postId').value);
  const delayMs = Number($('#delayMs').value || 300) || 0;
  if (!state.baseUrl || !state.sessionCookie) {
    alert('먼저 Base URL과 Session Cookie를 입력하고 이모지를 불러오세요.');
    return;
  }
  if (!postId) {
    alert('Post ID를 입력하세요.');
    return;
  }
  const emojis = state.selectedQueue.slice();
  if (emojis.length === 0) {
    alert('최소 1개 이상의 이모지를 선택하세요.');
    return;
  }
  log(`반응 전송 시작: ${emojis.length}개, delay=${delayMs}ms`);
  selLog(`전송 시작: ${emojis.length}개 (순서 유지)`);
  const res = await fetch('/api/reactions/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: state.baseUrl, sessionCookie: state.sessionCookie, postId, emojis, delayMs })
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const t = data ? JSON.stringify(data) : await res.text();
    log(`전송 실패: ${res.status} ${t}`);
    selLog(`전송 실패: ${res.status}`);
    return;
  }
  if (data && typeof data === 'object') {
    const { total, success, skipped, failed } = data;
    log(`전송 완료: 성공 ${success}, 중복 ${skipped}, 실패 ${failed} / 총 ${total}`);
    selLog(`전송 완료: 성공 ${success}, 중복 ${skipped}, 실패 ${failed}`);
    if (Array.isArray(data.results)) {
      const failures = data.results.filter(r => !r.ok).slice(0, 3);
      if (failures.length) {
        log(`실패 예시: ${failures.map(f => `${f.emoji}:${f.status}`).join(', ')}`);
      }
    }
  } else {
    const txt = await res.text();
    log(txt);
    selLog('전송 완료.');
  }
}

function composeSessionCookie() {
  const mmauthtoken = $('#mmauthtoken').value.trim();
  const mmcsrf = $('#mmcsrf').value.trim();
  if (!mmauthtoken) {
    alert('MMAUTHTOKEN 값을 입력하세요.');
    return;
  }
  const cookie = mmcsrf
    ? `MMAUTHTOKEN=${mmauthtoken}; MMCSRF=${mmcsrf}`
    : `MMAUTHTOKEN=${mmauthtoken}`;
  $('#sessionCookie').value = cookie;
  state.sessionCookie = cookie;
  log('Session Cookie 자동 구성 완료.');
}

async function loadLocalConfig() {
  try {
    const res = await fetch('/api/local-config');
    if (!res.ok) throw new Error(String(res.status));
    const { baseUrl = '', sessionCookie = '' } = await res.json();
    $('#baseUrl').value = baseUrl || '';
    $('#sessionCookie').value = sessionCookie || '';
    state.baseUrl = (baseUrl || '').trim().replace(/\/$/, '');
    state.sessionCookie = sessionCookie || '';
    if (baseUrl || sessionCookie) {
      log('로컬 설정을 불러왔습니다.');
    } else {
      log('로컬 설정 파일이 없어 빈 값으로 시작합니다.');
    }
  } catch (e) {
    log('로컬 설정 로드 중 오류가 발생했지만 계속 진행합니다.');
  }
}

$('#composeCookieBtn').addEventListener('click', composeSessionCookie);
$('#loadEmojisBtn').addEventListener('click', loadEmojis);
$('#sendReactionsBtn').addEventListener('click', sendReactions);
$('#searchBtn').addEventListener('click', onSearchInput);
$('#pastePostIdBtn').addEventListener('click', pastePostIdFromClipboard);

// Enter 키로 검색 실행
document.getElementById('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    onSearchInput();
  }
});

// 인덱스 재구축
async function forceReindex() {
  if (!state.baseUrl || !state.sessionCookie) {
    alert('먼저 Base URL과 Session Cookie를 입력하고 이모지를 불러오세요.');
    return;
  }
  try {
    setSearchStatus('인덱스 재구축 중...');
    const btn = document.getElementById('reindexBtn');
    if (btn) btn.disabled = true;
    const res = await fetch('/api/emoji/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: state.baseUrl, sessionCookie: state.sessionCookie })
    });
    if (!res.ok) {
      const t = await res.text();
      log(`인덱스 재구축 실패: ${res.status} ${t}`);
      return;
    }
    const data = await res.json();
    log(`인덱스 재구축 완료: ${data.count}개`);
    // 현재 검색어가 있으면 첫 페이지부터 다시 검색
    if (state.searchTerm) {
      state.searchOffset = 0;
      await globalSearch(state.searchTerm, { offset: 0, rebuild: false });
    }
  } catch (e) {
    log(`인덱스 재구축 예외: ${e.message}`);
  } finally {
    setSearchStatus('');
    const btn = document.getElementById('reindexBtn');
    if (btn) btn.disabled = false;
  }
}
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.id === 'reindexBtn') {
    forceReindex();
  }
});

// 초기 로컬 설정 자동 로드
document.addEventListener('DOMContentLoaded', async () => {
  await loadLocalConfig();
  await refreshPresetList();
});

// --- 선택 큐 관련 ---
function addToQueue(name) {
  state.selectedQueue.push(name);
  renderSelected();
  selLog(`추가: ${name} (선택 ${state.selectedQueue.length}개)`);
}

function removeFromQueue(index) {
  if (index >= 0 && index < state.selectedQueue.length) {
    const removed = state.selectedQueue[index];
    state.selectedQueue.splice(index, 1);
    renderSelected();
    selLog(`제거: ${removed} (남은 ${state.selectedQueue.length}개)`);
  }
}

function clearQueue() {
  state.selectedQueue = [];
  renderSelected();
  selLog('선택 전체 비움');
}

function renderSelected() {
  const wrap = document.getElementById('selectedList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const baseUrl = state.baseUrl;
  const sessionCookie = state.sessionCookie;
  const authQS = `sessionCookie=${encodeURIComponent(sessionCookie)}`;
  state.selectedQueue.forEach((name, idx) => {
    const div = document.createElement('div');
    div.className = 'selected-item';
    const id = state.nameToIdAll.get(name) || state.nameToId.get(name);
    if (id) {
      const img = document.createElement('img');
      img.alt = name;
      img.src = `/api/emoji/image/${encodeURIComponent(id)}?baseUrl=${encodeURIComponent(baseUrl)}&${authQS}`;
      div.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = name;
    div.appendChild(label);

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = 'x';
    rm.addEventListener('click', () => removeFromQueue(idx));
    div.appendChild(rm);

    wrap.appendChild(div);
  });
  // 선택 개수는 선택 로그로만 안내
  selLog(`현재 선택: ${state.selectedQueue.length}개`);
}

// 상단 버튼 바인딩 (index.html에 버튼 존재)
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.id === 'clearSelectedBtn') clearQueue();
  if (t && t.id === 'popSelectedBtn') removeFromQueue(state.selectedQueue.length - 1);
  if (t && t.id === 'savePresetBtn') savePreset();
  if (t && t.id === 'loadPresetBtn') loadPreset({ append: false });
  if (t && t.id === 'appendPresetBtn') loadPreset({ append: true });
  if (t && t.id === 'deletePresetBtn') deletePreset();
  if (t && t.id === 'prevPageBtn') {
    if (state.searchMode) {
      const newOffset = Math.max(0, state.searchOffset - state.searchLimit);
      if (newOffset !== state.searchOffset) {
        globalSearch(state.searchTerm, { offset: newOffset });
      }
    } else if (state.page > 0) {
      fetchPage(state.page - 1);
    }
  }
  if (t && t.id === 'nextPageBtn') {
    if (state.searchMode) {
      const newOffset = state.searchOffset + state.searchLimit;
      if (newOffset < state.searchTotal) {
        globalSearch(state.searchTerm, { offset: newOffset });
      }
    } else if (state.hasMore) {
      fetchPage(state.page + 1);
    }
  }
});

// perPage 변경 시 첫 페이지로 재로딩
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t && t.id === 'perPage') {
    if (!state.searchMode) fetchPage(0);
  }
  if (t && t.id === 'presetSelect') {
    // 선택 변경 시 이름 입력칸을 동기화
    const sel = document.getElementById('presetSelect');
    const nameInput = document.getElementById('presetName');
    if (sel && nameInput) nameInput.value = sel.value || '';
  }
});

// ===== 프리셋 기능 =====
async function refreshPresetList(selectName) {
  try {
    const res = await fetch('/api/presets');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const sel = document.getElementById('presetSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '(프리셋 선택)';
    sel.appendChild(empty);
    const names = Array.isArray(data.names) ? data.names : [];
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = n.name;
      opt.textContent = `${n.name} (${n.count})`;
      sel.appendChild(opt);
    }
    if (selectName) sel.value = selectName;
  } catch (e) {
    log(`프리셋 목록 로드 실패: ${e.message}`);
  }
}

function getPresetTargetName() {
  const input = document.getElementById('presetName');
  const sel = document.getElementById('presetSelect');
  const name = (input && input.value ? input.value : (sel && sel.value ? sel.value : '')).trim();
  return name;
}

async function savePreset() {
  const name = getPresetTargetName();
  if (!name) {
    alert('프리셋 이름을 입력하거나 선택하세요.');
    return;
  }
  const emojis = state.selectedQueue.slice();
  try {
    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emojis })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(`프리셋 저장 실패: ${res.status} ${JSON.stringify(data)}`);
      alert('프리셋 저장에 실패했습니다.');
      return;
    }
    log(`프리셋 저장 완료: ${name} (${emojis.length}개)`);
    await refreshPresetList(name);
    const sel = document.getElementById('presetSelect');
    const nameInput = document.getElementById('presetName');
    if (sel) sel.value = name;
    if (nameInput) nameInput.value = name;
  } catch (e) {
    log(`프리셋 저장 예외: ${e.message}`);
  }
}

async function loadPreset(opts = { append: false }) {
  const name = getPresetTargetName();
  if (!name) {
    alert('불러올 프리셋을 선택하거나 이름을 입력하세요.');
    return;
  }
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(`프리셋 불러오기 실패: ${res.status} ${JSON.stringify(data)}`);
      alert('프리셋을 찾을 수 없습니다.');
      return;
    }
    const arr = Array.isArray(data.emojis) ? data.emojis : [];
    if (opts.append) {
      state.selectedQueue.push(...arr);
      selLog(`프리셋 추가 불러오기: ${name} (+${arr.length})`);
    } else {
      state.selectedQueue = arr.slice();
      selLog(`프리셋 불러오기: ${name} (${arr.length})`);
    }
    renderSelected();
  } catch (e) {
    log(`프리셋 불러오기 예외: ${e.message}`);
  }
}

async function deletePreset() {
  const name = getPresetTargetName();
  if (!name) {
    alert('삭제할 프리셋을 선택하거나 이름을 입력하세요.');
    return;
  }
  if (!confirm(`프리셋 "${name}"을(를) 삭제할까요?`)) return;
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const txt = await res.text();
      log(`프리셋 삭제 실패: ${res.status} ${txt}`);
      alert('프리셋 삭제에 실패했습니다.');
      return;
    }
    log(`프리셋 삭제 완료: ${name}`);
    await refreshPresetList('');
    const nameInput = document.getElementById('presetName');
    if (nameInput) nameInput.value = '';
  } catch (e) {
    log(`프리셋 삭제 예외: ${e.message}`);
  }
}
