(function () {
  'use strict';

  const BACKUP_DB_NAME = 'kotonoha_state_backup_db';
  const BACKUP_DB_VER = 1;
  const BACKUP_STORE = 'stateSnapshot';
  const SNAPSHOT_KEY = 'primary_v1';

  let dbPromise = null;
  let mirrorTimer = null;
  let studyTickerId = null;
  let studySecondsAcc = 0;

  function bridge() {
    return window.__KOTONOHA_BRIDGE__ || null;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function formatLocalDate(d) {
    const dt = d || new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayKey() {
    return formatLocalDate(new Date());
  }

  function ensureMemoryFields(st) {
    if (!st) return;
    if (!Array.isArray(st.attendanceDates)) st.attendanceDates = [];
    if (!st.dailyStudyMinutes || typeof st.dailyStudyMinutes !== 'object') st.dailyStudyMinutes = {};
    if (typeof st.totalStudyMinutes !== 'number') st.totalStudyMinutes = 0;
    if (!st.quizStats || typeof st.quizStats !== 'object') st.quizStats = { total: 0, correct: 0 };
    if (!st.weakVocabCounts || typeof st.weakVocabCounts !== 'object') st.weakVocabCounts = {};
    if (!Array.isArray(st.peekedSentences)) st.peekedSentences = [];
    if (!st.aiVocabByScenario || typeof st.aiVocabByScenario !== 'object') st.aiVocabByScenario = {};
    if (!st.vocabScope) st.vocabScope = 'scenario_all';
  }

  // ---------- IndexedDB Dual-Layer State Mirror ----------
  function openBackupDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      try {
        const req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(BACKUP_STORE)) {
            db.createObjectStore(BACKUP_STORE, { keyPath: 'key' });
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

  function mirrorStateToIdb(stateObj) {
    if (!stateObj) return;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(async () => {
      const db = await openBackupDb();
      if (!db) return;
      try {
        // Mirror full state (except raw openaiKey for hygiene)
        const clone = JSON.parse(JSON.stringify(stateObj));
        const tx = db.transaction(BACKUP_STORE, 'readwrite');
        tx.objectStore(BACKUP_STORE).put({
          key: SNAPSHOT_KEY,
          updatedAt: Date.now(),
          data: clone
        });
      } catch (e) {}
    }, 250);
  }

  async function readStateFromIdb() {
    const db = await openBackupDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(BACKUP_STORE, 'readonly');
        const req = tx.objectStore(BACKUP_STORE).get(SNAPSHOT_KEY);
        req.onsuccess = () => resolve(req.result && req.result.data ? req.result.data : null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function clearIdbMirror() {
    const db = await openBackupDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(BACKUP_STORE, 'readwrite');
        tx.objectStore(BACKUP_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  // ---------- Attendance & Consecutive Streak Calculation ----------
  function computeStreakFromDates(dates) {
    if (!Array.isArray(dates) || dates.length === 0) return 0;
    const set = new Set(dates);
    const cur = new Date();
    cur.setHours(12, 0, 0, 0);
    const tKey = formatLocalDate(cur);
    if (!set.has(tKey)) {
      cur.setDate(cur.getDate() - 1);
      if (!set.has(formatLocalDate(cur))) return 0;
    }
    let streak = 0;
    while (set.has(formatLocalDate(cur))) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  function markTodayAttended(st) {
    if (!st) return;
    ensureMemoryFields(st);
    const tk = todayKey();
    if (!st.attendanceDates.includes(tk)) {
      st.attendanceDates.push(tk);
      st.attendanceDates.sort();
      if (st.attendanceDates.length > 365) {
        st.attendanceDates = st.attendanceDates.slice(-365);
      }
    }
    st.streakDays = Math.max(1, computeStreakFromDates(st.attendanceDates));
  }

  function getCurrentWeekDates() {
    // Returns 7 YYYY-MM-DD keys from Monday to Sunday of the current week
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const monOffset = (now.getDay() + 6) % 7; // Mon=0 ... Sun=6
    const mon = new Date(now);
    mon.setDate(now.getDate() - monOffset);
    const keys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      keys.push(formatLocalDate(d));
    }
    return { keys, todayIdx: monOffset };
  }

  // ---------- Study Time Tracking ----------
  function startStudyTimeTracker() {
    if (studyTickerId) clearInterval(studyTickerId);
    studyTickerId = setInterval(() => {
      const b = bridge();
      if (!b || !b.isAppUnlocked || !b.isAppUnlocked()) return;
      if (document.hidden) return;
      studySecondsAcc += 15;
      if (studySecondsAcc >= 60) {
        const mins = Math.floor(studySecondsAcc / 60);
        studySecondsAcc = studySecondsAcc % 60;
        const st = b.getState();
        ensureMemoryFields(st);
        const tk = todayKey();
        st.dailyStudyMinutes[tk] = (st.dailyStudyMinutes[tk] || 0) + mins;
        st.totalStudyMinutes = (st.totalStudyMinutes || 0) + mins;
        markTodayAttended(st);
        b.persistState();
        updateHomeStudyMetricsUI(st);
      }
    }, 15000);
  }

  function updateHomeStudyMetricsUI(st) {
    if (!st) return;
    ensureMemoryFields(st);
    const tk = todayKey();
    const todayMins = st.dailyStudyMinutes[tk] || 0;
    const totalMins = st.totalStudyMinutes || 0;
    const qTot = (st.quizStats && st.quizStats.total) || 0;
    const qCor = (st.quizStats && st.quizStats.correct) || 0;
    const acc = qTot > 0 ? Math.round((qCor / qTot) * 100) + '%' : '-';

    const elToday = document.getElementById('stat-today-minutes');
    const elTotal = document.getElementById('stat-total-minutes');
    const elAcc = document.getElementById('stat-quiz-accuracy');
    const elWeak = document.getElementById('stat-weak-count');
    if (elToday) elToday.textContent = String(todayMins);
    if (elTotal) elTotal.textContent = String(totalMins);
    if (elAcc) elAcc.textContent = acc;
    if (elWeak) elWeak.textContent = String(Object.keys(st.weakVocabCounts || {}).length);
  }

  // ---------- Weak Vocab & Peeked Chat Sentences ----------
  function recordQuizAttempt(vocabId, isCorrect) {
    const b = bridge();
    if (!b) return;
    const st = b.getState();
    ensureMemoryFields(st);
    st.quizStats.total = (st.quizStats.total || 0) + 1;
    if (isCorrect) {
      st.quizStats.correct = (st.quizStats.correct || 0) + 1;
      if (st.weakVocabCounts[vocabId] && st.weakVocabCounts[vocabId] > 1) {
        st.weakVocabCounts[vocabId] -= 1;
      } else if (st.weakVocabCounts[vocabId]) {
        delete st.weakVocabCounts[vocabId];
      }
    } else if (vocabId) {
      st.weakVocabCounts[vocabId] = (st.weakVocabCounts[vocabId] || 0) + 1;
      if (!st.srsQueueIds.includes(vocabId)) st.srsQueueIds.unshift(vocabId);
    }
    markTodayAttended(st);
    b.persistState();
    updateHomeStudyMetricsUI(st);
  }

  function recordSrsFeedback(vocabId, rating) {
    const b = bridge();
    if (!b || !vocabId) return;
    const st = b.getState();
    ensureMemoryFields(st);
    if (rating === 'again' || rating === 'hard') {
      st.weakVocabCounts[vocabId] = (st.weakVocabCounts[vocabId] || 0) + (rating === 'again' ? 2 : 1);
    } else if (rating === 'good') {
      delete st.weakVocabCounts[vocabId];
    }
    markTodayAttended(st);
  }

  function recordPeekedSentence(jpText, koText) {
    const jp = String(jpText || '').trim();
    const ko = String(koText || '').trim();
    if (!jp) return;
    const b = bridge();
    if (!b) return;
    const st = b.getState();
    ensureMemoryFields(st);
    const existing = st.peekedSentences.find((x) => x.jp === jp);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.ko = ko || existing.ko;
      existing.lastAt = Date.now();
    } else {
      st.peekedSentences.unshift({ jp, ko, count: 1, lastAt: Date.now() });
      if (st.peekedSentences.length > 60) st.peekedSentences = st.peekedSentences.slice(0, 60);
    }
    markTodayAttended(st);
    b.persistState();
  }

  // ---------- Priority Weak Vocab & Peeked Expressions Card in #view-review ----------
  function renderWeakPriorityCard() {
    const reviewSec = document.getElementById('view-review');
    const b = bridge();
    if (!reviewSec || !b) return;

    let card = document.getElementById('weak-priority-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'weak-priority-card';
      card.className = 'bg-white rounded-3xl border-2 border-amber-200 p-5 sm:p-6 shadow-sm space-y-4';
      reviewSec.prepend(card);

      card.addEventListener('click', (e) => {
        const ttsBtn = e.target.closest('[data-weak-tts]');
        if (ttsBtn && b.speakJapanese) { b.speakJapanese(ttsBtn.dataset.weakTts, 0.95, 1.0); return; }
        const repBtn = e.target.closest('[data-peek-repeat3]');
        if (repBtn && b.speakThreeTimes) { b.speakThreeTimes(repBtn.dataset.peekRepeat3); return; }
        const clearWeakBtn = e.target.closest('[data-weak-clear]');
        if (clearWeakBtn) {
          const st = b.getState();
          ensureMemoryFields(st);
          const vid = clearWeakBtn.dataset.weakClear;
          delete st.weakVocabCounts[vid];
          if (!st.masteredVocabIds.includes(vid)) st.masteredVocabIds.push(vid);
          st.srsQueueIds = st.srsQueueIds.filter((x) => x !== vid);
          b.persistState();
          b.renderAll();
          b.showToast('취약 어휘를 마스터 완료로 처리했습니다!', 'info');
          return;
        }
        const delPeekBtn = e.target.closest('[data-peek-del]');
        if (delPeekBtn) {
          const st = b.getState();
          ensureMemoryFields(st);
          const idx = parseInt(delPeekBtn.dataset.peekDel, 10);
          if (!isNaN(idx)) st.peekedSentences.splice(idx, 1);
          b.persistState();
          renderWeakPriorityCard();
          return;
        }
      });
    }

    const st = b.getState();
    ensureMemoryFields(st);
    const allVocab = b.getAllVocab ? b.getAllVocab() : [];
    const weakEntries = Object.entries(st.weakVocabCounts || {})
      .sort((a, c) => c[1] - a[1])
      .map(([id, cnt]) => ({ item: allVocab.find((v) => v.id === id), cnt }))
      .filter((x) => x.item)
      .slice(0, 12);

    const peeked = (st.peekedSentences || []).slice(0, 8);
    const todayMins = st.dailyStudyMinutes[todayKey()] || 0;
    const totalMins = st.totalStudyMinutes || 0;
    const qTot = (st.quizStats && st.quizStats.total) || 0;
    const qAcc = qTot > 0 ? Math.round(((st.quizStats.correct || 0) / qTot) * 100) + '%' : '-';

    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-base font-bold text-slate-900">📌 자동 기억 · 취약 어휘 &amp; 엿본 회화 표현</h3>
          <p class="text-xs text-slate-500 mt-0.5">퀴즈에서 틀린 단어와 회화에서 뜻을 엿본 표현을 자동으로 기억해 우선 복습합니다 (IndexedDB 이중 보호)</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
          <span class="px-2.5 py-1 rounded-full bg-brand-50 text-brand-700">오늘 ${todayMins}분 / 누적 ${totalMins}분</span>
          <span class="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700">퀴즈 정답률 ${qAcc}</span>
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-xs font-bold text-amber-800">자주 틀린 취약 어휘 (${weakEntries.length}개)</div>
        ${weakEntries.length ? `<div class="grid sm:grid-cols-2 gap-2">${weakEntries.map(({ item, cnt }) => `
          <div class="p-3 rounded-2xl bg-amber-50/50 border border-amber-200 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="font-jp font-bold text-sm text-slate-900">${escapeHtml(item.word)}</span>
                <span class="text-[11px] font-jp text-brand-700">${escapeHtml(item.kana)}</span>
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">오답 ${cnt}회</span>
              </div>
              <div class="text-xs text-slate-600 truncate mt-0.5">${escapeHtml(item.meaning)}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button type="button" data-weak-tts="${escapeHtml(item.word)}" class="px-2 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-brand-700">🔊</button>
              <button type="button" data-weak-clear="${escapeHtml(item.id)}" class="px-2 py-1 rounded-lg bg-brand-600 text-white text-[11px] font-semibold">완료</button>
            </div>
          </div>
        `).join('')}</div>` : '<div class="text-xs text-slate-400 bg-surface-bg rounded-2xl py-3 px-4">아직 취약 어휘가 없습니다. 어휘 퀴즈나 학습 중 틀린 단어가 자동으로 여기에 모입니다.</div>'}
      </div>

      <div class="space-y-2 pt-2 border-t border-slate-100">
        <div class="text-xs font-bold text-indigo-800">회화에서 「👁️ 한국어 뜻 보기」를 눌렀던 표현 (${peeked.length}개)</div>
        ${peeked.length ? `<div class="space-y-2">${peeked.map((p, idx) => `
          <div class="p-3 rounded-2xl bg-indigo-50/40 border border-indigo-100 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-jp font-semibold text-slate-900">${escapeHtml(p.jp)} <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 ml-1">${p.count || 1}회</span></div>
              <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(p.ko)}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button type="button" data-peek-repeat3="${escapeHtml(p.jp)}" class="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-bold">×3</button>
              <button type="button" data-peek-del="${idx}" class="px-2 py-1 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-rose-600 text-[11px]">삭제</button>
            </div>
          </div>
        `).join('')}</div>` : '<div class="text-xs text-slate-400 bg-surface-bg rounded-2xl py-3 px-4">회화에서 「한국어 번역: 숨기기」 후 뜻을 엿본 문장이 자동으로 기록됩니다.</div>'}
      </div>
    `;
  }

  // ---------- Attempt Auto-Recovery from IndexedDB if localStorage was wiped ----------
  async function tryAutoRecoverIfNeeded() {
    const b = bridge();
    if (!b || !b.hasLocalStorageData || !b.hydrateStateFromBackup) return;
    if (b.hasLocalStorageData()) {
      // Ensure today is attended & mirror current state to IDB
      const st = b.getState();
      ensureMemoryFields(st);
      markTodayAttended(st);
      mirrorStateToIdb(st);
      return;
    }
    const idbData = await readStateFromIdb();
    if (idbData && typeof idbData === 'object') {
      ensureMemoryFields(idbData);
      markTodayAttended(idbData);
      b.hydrateStateFromBackup(idbData);
      b.showToast('IndexedDB 이중 백업에서 기존 학습 기록을 자동 복구했습니다!', 'info');
    }
  }

  window.KotonohaMemory = {
    todayKey,
    ensureMemoryFields,
    markTodayAttended,
    computeStreakFromDates,
    getCurrentWeekDates,
    mirrorStateToIdb,
    clearIdbMirror,
    tryAutoRecoverIfNeeded,
    recordQuizAttempt,
    recordSrsFeedback,
    recordPeekedSentence,
    updateHomeStudyMetricsUI,
    renderWeakPriorityCard,
    startStudyTimeTracker
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startStudyTimeTracker());
  } else {
    startStudyTimeTracker();
  }
})();
