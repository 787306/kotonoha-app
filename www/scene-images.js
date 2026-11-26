(function () {
  'use strict';

  const DB_NAME = 'kotonoha_scene_images_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'customScenes';

  const DEFAULT_SCENE_FILES = {
    cafe:        './images/scenes/day01_cafe.jpg',
    konbini:     './images/scenes/day02_konbini.svg',
    hotel:       './images/scenes/day03_hotel.svg',
    shopping:    './images/scenes/day04_shopping.svg',
    izakaya:     './images/scenes/day05_izakaya.svg',
    hobby:       './images/scenes/day06_hobby.svg',
    hair:        './images/scenes/day07_hair.svg',
    hospital:    './images/scenes/day08_hospital.svg',
    phone:       './images/scenes/day09_phone.svg',
    rent:        './images/scenes/day10_rent.svg',
    office:      './images/scenes/day11_office.svg',
    trouble:     './images/scenes/day12_trouble.svg',
    ramen:       './images/scenes/day13_ramen.svg',
    taxi:        './images/scenes/day14_taxi.svg',
    post:        './images/scenes/day15_post.svg',
    bank:        './images/scenes/day16_bank.svg',
    supermarket: './images/scenes/day17_supermarket.svg',
    gym:         './images/scenes/day18_gym.svg',
    kyoto:       './images/scenes/day19_kyoto.svg',
    karaoke:     './images/scenes/day20_karaoke.svg',
    gift:        './images/scenes/day21_gift.svg',
    airport:     './images/scenes/day22_airport.svg',
    museum:      './images/scenes/day23_museum.svg',
    weather:     './images/scenes/day24_weather.svg',
    intro:       './images/scenes/day25_intro.svg',
    interview:   './images/scenes/day26_interview.svg',
    meeting:     './images/scenes/day27_meeting.svg',
    dinner:      './images/scenes/day28_dinner.svg',
    apology:     './images/scenes/day29_apology.svg',
    graduation:  './images/scenes/day30_graduation.svg'
  };

  let dbPromise = null;
  const customCache = new Map(); // scenarioId -> dataUrl
  let cacheLoaded = false;
  let pendingUploadScenarioId = null;

  function bridge() {
    return window.__KOTONOHA_BRIDGE__ || null;
  }

  function toast(msg, type) {
    const b = bridge();
    if (b && b.showToast) b.showToast(msg, type || 'info');
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // ---------- IndexedDB Wrapper ----------
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function loadAllCustomFromDb() {
    if (cacheLoaded) return;
    const db = await openDb();
    if (!db) { cacheLoaded = true; return; }
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = req.result || [];
          for (const r of rows) {
            if (r && r.id && r.dataUrl) customCache.set(r.id, r.dataUrl);
          }
          cacheLoaded = true;
          resolve();
        };
        req.onerror = () => { cacheLoaded = true; resolve(); };
      } catch (e) {
        cacheLoaded = true;
        resolve();
      }
    });
  }

  async function saveCustomImage(scenarioId, dataUrl) {
    customCache.set(scenarioId, dataUrl);
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id: scenarioId, dataUrl, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  async function removeCustomImage(scenarioId) {
    customCache.delete(scenarioId);
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(scenarioId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async function clearAllCustomImages() {
    customCache.clear();
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
    refreshCurrentHero();
    renderSettingsManagerGrid();
  }

  // ---------- Image Optimization (Canvas Resize + Compress) ----------
  function processUploadedImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('이미지 파일(JPG, PNG, WEBP, SVG 등)만 선택할 수 있습니다.'));
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        reject(new Error('파일 용량이 너무 큽니다 (최대 15MB).'));
        return;
      }

      // Keep SVG crisp without rasterization (up to 512KB)
      if (file.type === 'image/svg+xml' && file.size <= 512 * 1024) {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result || ''));
        rd.onerror = () => reject(new Error('SVG 파일을 읽지 못했습니다.'));
        rd.readAsDataURL(file);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('지원되지 않거나 손상된 이미지 파일입니다.'));
        img.onload = () => {
          const MAX_W = 1200;
          const MAX_H = 750;
          let w = img.naturalWidth || img.width || 800;
          let h = img.naturalHeight || img.height || 500;
          const scale = Math.min(1, MAX_W / w, MAX_H / h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#F6F9F8';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          try {
            const outUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(outUrl);
          } catch (e) {
            resolve(String(reader.result || ''));
          }
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Resolve & Apply Hero Image ----------
  function getDefaultSrc(scenarioId) {
    return DEFAULT_SCENE_FILES[scenarioId] || DEFAULT_SCENE_FILES.cafe;
  }

  function getSceneSrc(scenarioId) {
    if (customCache.has(scenarioId)) return customCache.get(scenarioId);
    return getDefaultSrc(scenarioId);
  }

  function isCustomized(scenarioId) {
    return customCache.has(scenarioId);
  }

  function applyHeroImage(sc) {
    if (!sc || !sc.id) return;
    const imgEl = document.getElementById('home-hero-img');
    const resetBtn = document.getElementById('btn-home-reset-img');
    if (!imgEl) return;

    const targetSrc = getSceneSrc(sc.id);
    if (imgEl.dataset.sceneSrc !== targetSrc) {
      imgEl.dataset.fallbackTried = '0';
      imgEl.dataset.sceneId = sc.id;
      imgEl.dataset.sceneSrc = targetSrc;
      imgEl.src = targetSrc;
    }
    imgEl.alt = `${sc.title || sc.shortName || sc.id} 에피소드 일러스트`;

    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !isCustomized(sc.id));
    }
  }

  function refreshCurrentHero() {
    const b = bridge();
    if (!b || !b.getScenario) return;
    applyHeroImage(b.getScenario());
  }

  // ---------- Settings Manager UI (Mounted inside Display Sub-Page) ----------
  function getSortedScenarios() {
    const b = bridge();
    const map = b && b.getScenarios ? b.getScenarios() : null;
    if (!map) return [];
    return Object.values(map).sort((a, c) => (a.day || 999) - (c.day || 999));
  }

  function renderSettingsManagerGrid() {
    const grid = document.getElementById('scene-manager-grid');
    const countEl = document.getElementById('scene-manager-custom-count');
    if (!grid) return;

    const list = getSortedScenarios();
    if (countEl) {
      countEl.textContent = customCache.size > 0
        ? `커스텀 적용 ${customCache.size} / ${list.length}개`
        : `기본 30일 일러스트 적용 중`;
    }

    grid.innerHTML = list.map((sc) => {
      const cust = isCustomized(sc.id);
      const src = getSceneSrc(sc.id);
      return `
        <div class="rounded-2xl border ${cust ? 'border-brand-400 bg-brand-50/40' : 'border-surface-border bg-surface-bg'} overflow-hidden flex flex-col">
          <div class="relative h-24 bg-slate-100 overflow-hidden">
            <img src="${src}" alt="${escapeHtml(sc.shortName)}" loading="lazy" class="w-full h-full object-cover" />
            <span class="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-full bg-slate-900/75 text-white text-[10px] font-bold">Day ${sc.day}</span>
            ${cust ? '<span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full bg-brand-600 text-white text-[9px] font-bold">커스텀</span>' : ''}
          </div>
          <div class="p-2.5 flex-1 flex flex-col justify-between gap-2">
            <div class="text-xs font-bold text-slate-900 truncate" title="${escapeHtml(sc.title)}">${escapeHtml(sc.shortName || sc.title)}</div>
            <div class="flex items-center gap-1.5">
              <button type="button" data-scene-change="${escapeHtml(sc.id)}" class="flex-1 px-2 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-brand-400 text-[11px] font-semibold text-slate-700 hover:text-brand-700 transition">변경</button>
              ${cust ? `<button type="button" data-scene-reset="${escapeHtml(sc.id)}" class="px-2 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 transition">복원</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function mountSettingsManager(parentEl) {
    if (!parentEl || parentEl.querySelector('#scene-manager-card') || document.getElementById('scene-manager-card')) return;

    const card = document.createElement('div');
    card.id = 'scene-manager-card';
    card.className = 'bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4';
    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-sm font-bold text-slate-900">에피소드별 상황 그림 관리 (Day 1 ~ Day 30)</h4>
            <span id="scene-manager-custom-count" class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-brand-50 text-brand-700">기본 30일 일러스트 적용 중</span>
          </div>
          <p class="text-xs text-slate-500 mt-1">
            각 날짜(상황)마다 기본 일러스트가 자동 전환되며, 원하는 날짜의 그림을 내 사진·그림 파일로 자유롭게 바꿀 수 있습니다.
          </p>
        </div>
        <button type="button" id="btn-scene-reset-all" class="px-3 py-2 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition shrink-0">
          ↺ 전체 기본 그림 복원
        </button>
      </div>
      <div id="scene-manager-grid" class="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[420px] overflow-y-auto custom-scroll pr-1"></div>
      <input id="scene-manager-file-input" type="file" accept="image/*" class="hidden" />
      <p class="text-[11px] text-slate-500">
        ※ 커스텀 그림은 기기 내부 IndexedDB에 자동 최적화되어 저장됩니다. APK 빌드 전 기본 그림을 영구 교체하려면 <code>www/images/scenes/</code> 폴더 파일을 교체하세요.
      </p>
    `;
    parentEl.appendChild(card);

    const fileInput = card.querySelector('#scene-manager-file-input');

    card.addEventListener('click', async (e) => {
      const chBtn = e.target.closest('[data-scene-change]');
      if (chBtn) {
        pendingUploadScenarioId = chBtn.dataset.sceneChange;
        fileInput.value = '';
        fileInput.click();
        return;
      }
      const rsBtn = e.target.closest('[data-scene-reset]');
      if (rsBtn) {
        const sid = rsBtn.dataset.sceneReset;
        await removeCustomImage(sid);
        refreshCurrentHero();
        renderSettingsManagerGrid();
        toast('기본 상황 일러스트로 복원했습니다!', 'info');
        return;
      }
    });

    if (fileInput) fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const sid = pendingUploadScenarioId;
      e.target.value = '';
      if (!file || !sid) return;
      try {
        const dataUrl = await processUploadedImage(file);
        await saveCustomImage(sid, dataUrl);
        refreshCurrentHero();
        renderSettingsManagerGrid();
        toast('에피소드 그림이 성공적으로 변경되었습니다!', 'info');
      } catch (err) {
        toast(err.message || '이미지 변경에 실패했습니다.', 'error');
      }
    });

    const resetAllBtn = card.querySelector('#btn-scene-reset-all');
    if (resetAllBtn) resetAllBtn.addEventListener('click', async () => {
      if (customCache.size === 0) {
        toast('이미 모든 에피소드가 기본 상황 그림으로 설정되어 있습니다.', 'info');
        return;
      }
      await clearAllCustomImages();
      toast('30일 전체 에피소드를 기본 상황 일러스트로 복원했습니다!', 'info');
    });

    renderSettingsManagerGrid();
  }

  // ---------- Bind Home Hero Image Direct Buttons ----------
  function bindHomeHeroControls() {
    const imgEl = document.getElementById('home-hero-img');
    const changeBtn = document.getElementById('btn-home-change-img');
    const resetBtn = document.getElementById('btn-home-reset-img');
    const fileInput = document.getElementById('home-hero-img-input');

    if (imgEl) {
      imgEl.addEventListener('error', () => {
        const sid = imgEl.dataset.sceneId || 'cafe';
        const fallback = getDefaultSrc(sid);
        if (imgEl.dataset.fallbackTried !== '1') {
          imgEl.dataset.fallbackTried = '1';
          imgEl.src = fallback;
        } else if (imgEl.dataset.fallbackTried !== '2') {
          imgEl.dataset.fallbackTried = '2';
          imgEl.src = DEFAULT_SCENE_FILES.cafe;
        }
      });
    }

    if (changeBtn && fileInput) {
      changeBtn.addEventListener('click', () => {
        fileInput.value = '';
        fileInput.click();
      });

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const b = bridge();
        const sc = b && b.getScenario ? b.getScenario() : null;
        if (!sc) return;
        try {
          const dataUrl = await processUploadedImage(file);
          await saveCustomImage(sc.id, dataUrl);
          if (imgEl) imgEl.dataset.fallbackTried = '0';
          applyHeroImage(sc);
          renderSettingsManagerGrid();
          toast(`Day ${sc.day} (${sc.shortName}) 그림을 변경했습니다!`, 'info');
        } catch (err) {
          toast(err.message || '이미지 변경에 실패했습니다.', 'error');
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const b = bridge();
        const sc = b && b.getScenario ? b.getScenario() : null;
        if (!sc) return;
        await removeCustomImage(sc.id);
        if (imgEl) imgEl.dataset.fallbackTried = '0';
        applyHeroImage(sc);
        renderSettingsManagerGrid();
        toast(`Day ${sc.day} 기본 상황 그림으로 복원했습니다`, 'info');
      });
    }
  }

  async function initScenes() {
    bindHomeHeroControls();
    refreshCurrentHero();
    await loadAllCustomFromDb();
    refreshCurrentHero();
    renderSettingsManagerGrid();
  }

  window.KotonohaScenes = {
    DEFAULT_SCENE_FILES,
    applyHeroImage,
    refreshCurrentHero,
    mountSettingsManager,
    renderSettingsManagerGrid,
    clearAllCustomImages
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initScenes);
  else initScenes();
})();
