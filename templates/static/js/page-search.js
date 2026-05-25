;(() => {
  if (!document.body.classList.contains('page-search')) return;
const params = new URLSearchParams(location.search);
let currentPage = parseInt(params.get('page') || '1', 10);
let isLoading = false;
let seenVideoIds = new Set();

let allShortsFound = [];
let shortsSeenIds = new Set();
let shortsShelfEl = null;
let shortsAutoGen = 0;
let currentSearchQuery = '';

function getFilters() {
  return {
    q: document.getElementById('searchInput').value.trim(),
    page: currentPage,
    sort_by: document.getElementById('sortSelect').value,
    date: document.getElementById('dateSelect').value,
    duration: document.getElementById('durationSelect').value,
    type: document.getElementById('typeSelect').value,
    features: getCheckedFeatures(),
    region: document.getElementById('regionSelect').value,
  };
}

function getCheckedFeatures() {
  const checked = [...document.querySelectorAll('#featuresDropdown input:checked')];
  return checked.map(c => c.value).join(',');
}

function buildApiPath(filters) {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.page > 1) p.set('page', filters.page);
  if (filters.sort_by && filters.sort_by !== 'relevance') p.set('sort_by', filters.sort_by);
  if (filters.date) p.set('date', filters.date);
  if (filters.duration) p.set('duration', filters.duration);
  if (filters.type && filters.type !== 'all') p.set('type', filters.type);
  if (filters.features) p.set('features', filters.features);
  if (filters.region) p.set('region', filters.region);
  return `/api/search?${p.toString()}`;
}

function pushState(filters) {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.page > 1) p.set('page', filters.page);
  if (filters.sort_by && filters.sort_by !== 'relevance') p.set('sort_by', filters.sort_by);
  if (filters.date) p.set('date', filters.date);
  if (filters.duration) p.set('duration', filters.duration);
  if (filters.type && filters.type !== 'all') p.set('type', filters.type);
  if (filters.features) p.set('features', filters.features);
  if (filters.region && filters.region !== 'JP') p.set('region', filters.region);
  history.pushState(null, '', `/search?${p.toString()}`);
  document.title = filters.q ? `${filters.q} — Choco-tube-plus` : '検索 — Choco-tube-plus';
}

function showResultLoading() {
  const grid = document.getElementById('resultGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 20; i++) grid.appendChild(createSkeletonCard());
  document.getElementById('resultHeader').hidden = true;
  document.getElementById('pagination').hidden = true;
}

function updateFeaturesLabel() {
  const checked = [...document.querySelectorAll('#featuresDropdown input:checked')];
  const label = document.getElementById('featuresLabel');
  label.textContent = checked.length ? checked.map(c => c.value.toUpperCase()).join(', ') : 'すべて';
}

const CACHE_TTL = 5 * 60 * 1000;

function cacheKey(filters) {
  return 'search:' + buildApiPath(filters);
}

function saveCache(filters, results) {
  try {
    sessionStorage.setItem(cacheKey(filters), JSON.stringify({ ts: Date.now(), results, page: filters.page }));
  } catch {}
}

function loadCache(filters) {
  try {
    const raw = sessionStorage.getItem(cacheKey(filters));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.ts > CACHE_TTL) { sessionStorage.removeItem(cacheKey(filters)); return null; }
    return data;
  } catch { return null; }
}

function initShortsSection(q) {
  const section = document.getElementById('shortsSection');
  section.innerHTML = '';
  const shelf = createShortsShelf([], { searchQuery: q });
  const scroll = shelf.querySelector('.shorts-shelf-scroll');
  const spinner = document.createElement('div');
  spinner.className = 'shorts-shelf-spinner';
  spinner.innerHTML = '<span class="shorts-loading-text">ショートを検索中...</span>';
  scroll.appendChild(spinner);
  section.appendChild(shelf);
  section.hidden = false;
  shortsShelfEl = shelf;
}


async function startShortsAutoFetch(q, region, gen) {
  const maxPages = 6;
  const q1 = q + ' ショート';
  const q2 = q + ' #shorts';

  function _addShorts(items) {
    if (gen !== shortsAutoGen) return;
    const newShorts = items.filter(item =>
      item.videoId && isShortVideo(item) && !shortsSeenIds.has(item.videoId)
    );
    newShorts.forEach(item => {
      shortsSeenIds.add(item.videoId);
      allShortsFound.push(item);
    });
    if (newShorts.length > 0 && shortsShelfEl) {
      appendShortsToShelf(shortsShelfEl, newShorts, allShortsFound, q);
      const section = document.getElementById('shortsSection');
      if (section) section.hidden = false;
    }
    return newShorts.length;
  }

  async function fetchOnePage(searchQ, page) {
    if (gen !== shortsAutoGen) return 0;
    try {
      const pageParam = page > 1 ? `&page=${page}` : '';
      const url = `/api/search?q=${encodeURIComponent(searchQ)}&region=${encodeURIComponent(region || 'JP')}${pageParam}`;
      const raw = await fetchMain(url);
      if (gen !== shortsAutoGen) return 0;
      const items = Array.isArray(raw) ? raw : (raw.results || []);
      _addShorts(items);
      return items.length;
    } catch (e) {
      console.warn('Shorts fetch error (' + searchQ + ' p' + page + '):', e);
      return 0;
    }
  }

  function _makeSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      return AbortSignal.timeout(ms);
    }
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  }

  const innertubePromise = (async () => {
    const maxContPages = 4;
    try {
      const res = await fetch(
        `/api/innertube-shorts-search?q=${encodeURIComponent(q)}`,
        { signal: _makeSignal(15000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.error) return;
      if (Array.isArray(data.items)) _addShorts(data.items);
      let contKey = data.contKey || null;
      for (let i = 0; i < maxContPages && contKey && gen === shortsAutoGen; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (gen !== shortsAutoGen) return;
        try {
          const cr = await fetch(
            `/api/innertube-shorts-search-cont?contKey=${encodeURIComponent(contKey)}`,
            { signal: _makeSignal(15000) }
          );
          if (!cr.ok) break;
          const cd = await cr.json();
          if (cd.error) break;
          if (Array.isArray(cd.items)) _addShorts(cd.items);
          contKey = cd.contKey || null;
        } catch (e) {
          console.warn('InnerTube shorts cont error:', e);
          break;
        }
      }
    } catch (e) {
      console.warn('InnerTube shorts search error:', e);
    }
  })();

  let q2Promise = null;

  for (let page = 1; page <= maxPages; page++) {
    if (gen !== shortsAutoGen) return;

    if (page === 3 && !q2Promise) {
      q2Promise = (async () => {
        for (let p = 1; p <= maxPages; p++) {
          if (gen !== shortsAutoGen) return;
          const count = await fetchOnePage(q2, p);
          if (count < 5) break;
          await new Promise(r => setTimeout(r, 400));
        }
      })();
    }

    const count = await fetchOnePage(q1, page);
    if (count < 5) break;
    await new Promise(r => setTimeout(r, 350));
  }

  await Promise.allSettled([q2Promise, innertubePromise].filter(Boolean));

  if (gen === shortsAutoGen && allShortsFound.length === 0 && shortsShelfEl) {
    const scroll = shortsShelfEl.querySelector('.shorts-shelf-scroll');
    if (scroll) {
      const spinner = scroll.querySelector('.shorts-shelf-spinner');
      if (spinner) spinner.remove();
      const empty = document.createElement('span');
      empty.className = 'shorts-empty-text';
      empty.textContent = 'ショートが見つかりませんでした';
      scroll.appendChild(empty);
    }
  }
}

function renderRegularResults(results, q) {
  const grid = document.getElementById('resultGrid');
  grid.innerHTML = '';

  if (!results.length) {
    const section = document.getElementById('shortsSection');
    if (!section || section.hidden) {
      grid.innerHTML = `<div class="empty-state"><p>「${escapeHtml(q)}」の検索結果が見つかりませんでした。</p></div>`;
      document.getElementById('resultHeader').hidden = true;
      document.getElementById('pagination').hidden = true;
    }
    return;
  }

  const missingIcons = [];
  results.forEach(item => {
    const card = createResultCard(item);
    grid.appendChild(card);
    if (!item.authorThumbnails) {
      if (item.authorId) missingIcons.push({ card, authorId: item.authorId });
      else if (item.playlistId) missingIcons.push({ card, playlistId: item.playlistId });
    }
  });
  if (missingIcons.length > 0) fillMissingIcons(missingIcons);

  const info = document.getElementById('resultInfo');
  info.textContent = `「${q}」の検索結果 — ${results.length}件`;
  document.getElementById('resultHeader').hidden = false;
  updatePagination(results.length);
}

async function doSearch(resetPage = false) {
  if (isLoading) return;
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;

  if (resetPage) {
    currentPage = 1;
    seenVideoIds = new Set();
    allShortsFound = [];
    shortsSeenIds = new Set();
    shortsShelfEl = null;
    shortsAutoGen++;
    currentSearchQuery = q;
    const section = document.getElementById('shortsSection');
    if (section) { section.innerHTML = ''; section.hidden = true; }
  }

  isLoading = true;

  const filters = getFilters();
  pushState(filters);

  const isNewQuery = !shortsShelfEl && (resetPage || currentSearchQuery !== q);

  if (!resetPage) {
    const cached = loadCache(filters);
    if (cached) {
      renderRegularResults(cached.results, q);
      if (isNewQuery) {
        currentSearchQuery = q;
        allShortsFound = [];
        shortsSeenIds = new Set();
        shortsShelfEl = null;
        shortsAutoGen++;
        initShortsSection(q);
        startShortsAutoFetch(q, filters.region, shortsAutoGen);
      }
      isLoading = false;
      return;
    }
  }

  showResultLoading();

  if (resetPage || isNewQuery) {
    currentSearchQuery = q;
    initShortsSection(q);
  }

  try {
    const raw = await fetchMain(buildApiPath(filters));
    const allResults = Array.isArray(raw) ? raw : (raw.results || []);
    const results = allResults.filter(item => {
      const id = item.videoId || item.playlistId || item.authorId;
      if (!id || seenVideoIds.has(id)) return false;
      seenVideoIds.add(id);
      return true;
    });

    const regularResults = results.filter(item =>
      item.type === 'channel' || item.type === 'playlist' || !isShortVideo(item)
    );

    if (resetPage || isNewQuery) {
      const mainShorts = results.filter(item =>
        item.type !== 'channel' && item.type !== 'playlist' && isShortVideo(item)
      );
      if (mainShorts.length > 0) {
        mainShorts.forEach(item => {
          if (!shortsSeenIds.has(item.videoId)) {
            shortsSeenIds.add(item.videoId);
            allShortsFound.push(item);
          }
        });
        if (shortsShelfEl) {
          appendShortsToShelf(shortsShelfEl, mainShorts, allShortsFound, q);
        }
      }
    }

    if (regularResults.length > 0) saveCache(filters, regularResults);
    renderRegularResults(regularResults, q);

    if (resetPage || isNewQuery) {
      const gen = shortsAutoGen;
      startShortsAutoFetch(q, filters.region, gen);
    }
  } catch (e) {
    const grid = document.getElementById('resultGrid');
    grid.innerHTML = `<div class="error-state"><div class="error-icon">⚠️</div><p>検索に失敗しました。しばらく経ってから再試行してください。</p></div>`;
    document.getElementById('resultHeader').hidden = true;
    document.getElementById('pagination').hidden = true;
    console.error(e);
  } finally {
    isLoading = false;
  }
}

function updatePagination(count) {
  const pg = document.getElementById('pagination');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pageInfo = document.getElementById('pageInfo');

  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = count < 10;
  pageInfo.textContent = `${currentPage} ページ`;
  pg.hidden = false;
}


function populateRegionSelect() {
  const sel = document.getElementById('regionSelect');
  const region = params.get('region') || 'JP';
  [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = `${c.name} (${c.code})`;
    if (c.code === region) opt.selected = true;
    sel.appendChild(opt);
  });
}

function restoreFilters() {
  const q = params.get('q') || '';
  const sort = params.get('sort_by') || 'relevance';
  const date = params.get('date') || '';
  const duration = params.get('duration') || '';
  const type = params.get('type') || 'all';
  const features = params.get('features') || '';
  currentPage = parseInt(params.get('page') || '1', 10);

  document.getElementById('searchInput').value = q;
  document.getElementById('sortSelect').value = sort;
  document.getElementById('dateSelect').value = date;
  document.getElementById('durationSelect').value = duration;
  document.getElementById('typeSelect').value = type;

  if (features) {
    features.split(',').forEach(f => {
      const cb = document.querySelector(`#featuresDropdown input[value="${f}"]`);
      if (cb) cb.checked = true;
    });
    updateFeaturesLabel();
  }

  if (q) document.title = `${q} — Choco-tube-plus`;
}

function bindEvents() {
  const featuresToggle = document.getElementById('featuresToggle');
  const featuresDropdown = document.getElementById('featuresDropdown');

  featuresToggle.addEventListener('click', () => {
    const hidden = featuresDropdown.hidden;
    featuresDropdown.hidden = !hidden;
    featuresToggle.classList.toggle('active', !hidden ? false : true);
  });

  document.addEventListener('click', (e) => {
    if (!featuresToggle.contains(e.target) && !featuresDropdown.contains(e.target)) {
      featuresDropdown.hidden = true;
      featuresToggle.classList.remove('active');
    }
  });

  document.querySelectorAll('#featuresDropdown input').forEach(cb => {
    cb.addEventListener('change', updateFeaturesLabel);
  });

  document.getElementById('typeSelect').addEventListener('change', () => {
    const type = document.getElementById('typeSelect').value;
    if (type !== 'video' && type !== 'all') {
      document.getElementById('durationSelect').value = '';
    }
    doSearch(true);
  });

  const filterSelects = ['sortSelect', 'dateSelect', 'durationSelect', 'regionSelect'];
  filterSelects.forEach(id => {
    document.getElementById(id).addEventListener('change', () => doSearch(true));
  });

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; doSearch(false); window.scrollTo({ top: 0 }); }
  });

  document.getElementById('nextBtn').addEventListener('click', () => {
    currentPage++;
    doSearch(false);
    window.scrollTo({ top: 0 });
  });
}

function init() {
  populateRegionSelect();
  restoreFilters();
  bindEvents();
  initHeaderSearch({ onSubmit: () => doSearch(true) });

  const q = params.get('q');
  if (q) doSearch(false);
  else {
    document.getElementById('resultGrid').innerHTML =
      `<div class="empty-state"><p>キーワードを入力して検索してください。</p></div>`;
  }
}

init();
})();
