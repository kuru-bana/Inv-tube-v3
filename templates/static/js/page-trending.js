;(() => {
  if (!document.body.classList.contains('page-trending')) return;
let currentRegion = 'JP';
let currentCategory = '';

function showLoading() {
  const grid = document.getElementById('trendingGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 20; i++) grid.appendChild(createSkeletonCard());
}

function showError(msg) {
  const grid = document.getElementById('trendingGrid');
  grid.innerHTML = `<div class="error-state"><div class="error-icon">⚠️</div><p>${msg}</p></div>`;
}

async function loadTrending(region, category) {
  showLoading();
  try {
    const endpoint = category
      ? `/api/trending/${category}?region=${region}`
      : `/api/trending?region=${region}`;
    const raw = await fetchMain(endpoint);
    const data = Array.isArray(raw) ? raw : (raw.results || []);
    const grid = document.getElementById('trendingGrid');
    grid.innerHTML = '';

    if (!data.length) {
      grid.innerHTML = `<div class="empty-state"><p>この地域のトレンド動画が見つかりませんでした。</p></div>`;
      return;
    }

    const missingIcons = [];
    data.forEach(video => {
      const card = createVideoCard(video);
      grid.appendChild(card);
      if (!video.authorThumbnails && video.authorId) {
        missingIcons.push({ card, authorId: video.authorId });
      }
    });
    if (missingIcons.length > 0) fillMissingIcons(missingIcons);
  } catch (e) {
    showError('トレンド動画の取得に失敗しました。しばらく経ってから再試行してください。');
    console.error(e);
  }
}

function populateRegionSelect() {
  const sel = document.getElementById('regionSelect');
  [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = `${c.name} (${c.code})`;
    if (c.code === 'JP') opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    currentRegion = sel.value;
    loadTrending(currentRegion, currentCategory);
  });
}

function initCategoryTabs() {
  const tabs = document.querySelectorAll('.category-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentCategory = tab.dataset.category;
      loadTrending(currentRegion, currentCategory);
    });
  });
}

function init() {
  populateRegionSelect();
  initCategoryTabs();
  loadTrending(currentRegion, currentCategory);
  initHeaderSearch();
}

init();
})();
