(function () {
  'use strict';

  const APP_VERSION = 'v2.4.2 · 31일판(안경점 Day30·졸업 Day31) + 1,100어휘';
  const VAULT_STORAGE_KEY = 'kotonoha_ai_vault_v1';
  const PREFS_STORAGE_KEY = 'kotonoha_prefs_v1';
  const REMINDER_NOTIF_ID = 20261125;
  const BACKUP_PROFILE_ID = '__backup_api__';
  const GEMINI_FAST_TEXT_MODEL = 'gemini-3.5-flash-lite';

  const DEFAULT_PREFS = {
    theme: 'light',
    jpFontSize: 'normal',
    liveReplyLength: 'normal',
    liveSpeedHint: 'normal',
    liveStartMuted: false,
    reminderEnabled: false,
    reminderTime: '21:00',
    reminderMessage: '오늘의 12분 일본어 회화 연습 시간이에요! 코토노하와 함께 시작해 볼까요?',
    lastWebReminderDate: '',
    audioOutputId: '',
    audioInputId: '',
    useAudioElementBridge: true
  };

  const PROVIDER_TEMPLATES = {
    'gemini-openai': {
      label: 'Google Gemini (OpenAI 호환 턴제)',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: GEMINI_FAST_TEXT_MODEL
    },
    'openai': {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    },
    'qwen-intl': {
      label: 'Qwen (DashScope 글로벌)',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus'
    },
    'qwen-cn': {
      label: 'Qwen (DashScope 중국)',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus'
    },
    'deepseek': {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat'
    },
    'openrouter': {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-2.5-flash'
    }
  };

  const SETTINGS_PAGES = {
    hub:      { title: '앱 설정' },
    ai:       { title: 'AI · API 설정' },
    security: { title: '보안 및 비밀번호' },
    display:  { title: '화면 · 보기 설정' },
    learning: { title: '학습 기본값' },
    reminder: { title: '일일 학습 알림' },
    voice:    { title: '음성 · 마이크 진단' },
    data:     { title: '데이터 · 캐시 · 앱 정보' }
  };

  function createDefaultBackupApi() {
    return {
      enabled: true,
      name: '예비 API (자동 전환)',
      type: 'openai-compat',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: '',
      model: GEMINI_FAST_TEXT_MODEL
    };
  }

  function createDefaultVaultData() {
    return {
      activeProfileId: 'builtin',
      pinnedProfileId: '',
      editLocked: false,
      profiles: [
        {
          id: 'prof_gemini_live_default',
          name: 'Gemini Live 실시간 일본어',
          type: 'gemini-live',
          authMode: 'apiKey',
          apiKey: '',
          tokenUrl: '',
          model: 'gemini-3.1-flash-live-preview',
          voiceName: 'Kore',
          sendLangHint: false
        },
        {
          id: 'prof_gemini_turn_default',
          name: 'Google Gemini 턴제 회화',
          type: 'openai-compat',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          apiKey: '',
          model: GEMINI_FAST_TEXT_MODEL
        }
      ],
      backupApi: createDefaultBackupApi()
    };
  }

  // ---------- Preferences (Non-Secret) ----------
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
    } catch (e) {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  let prefs = loadPrefs();

  function applyDisplayPrefs() {
    const root = document.documentElement;
    root.classList.toggle('dark-mode', prefs.theme === 'dark');
    root.classList.remove('jp-font-lg', 'jp-font-xl');
    if (prefs.jpFontSize === 'lg') root.classList.add('jp-font-lg');
    else if (prefs.jpFontSize === 'xl') root.classList.add('jp-font-xl');
  }
  applyDisplayPrefs();

  // ---------- In-Memory Secret Vault State (Wiped on Lock) ----------
  let vaultCryptoKey = null;
  let vaultSaltHex = '';
  let vaultUnlocked = false;
  let vaultData = createDefaultVaultData();
  let editingProfileId = null;

  // ---------- Settings Navigation State ----------
  let currentSettingsPage = 'hub';
  let explicitSubpageTarget = null;
  let settingsHubReady = false;
  let reminderTimerId = null;

  // ---------- Gemini Live WebSocket & Audio State ----------
  let ws = null;
  let isLiveActive = false;
  let isSetupComplete = false;
  let isMuted = false;
  let micStream = null;
  let captureCtx = null;
  let captureSource = null;
  let captureProc = null;
  let pcmChunkBuffer = [];
  let pcmChunkSamples = 0;

  let playCtx = null;
  let playDestNode = null;
  let playAudioEl = null;
  let nextPlayTime = 0;
  const activeSources = new Set();

  // Live streaming chat bubble & session audio replay store
  let pendingUserText = '';
  let pendingAiText = '';
  let liveAiBubbleRef = null;      // { id, chatKey }
  let liveAiPcmChunks = [];        // Int16Array[] for current AI turn replay
  const liveAudioBlobUrls = new Map(); // audioId -> blobUrl
  let activeReplayAudio = null;
  let isCompatBusy = false;

  // ---------- Bridge & Utility Helpers ----------
  function bridge() {
    return window.__KOTONOHA_BRIDGE__ || null;
  }

  function toast(msg, type) {
    const b = bridge();
    if (b && b.showToast) b.showToast(msg, type || 'info');
  }

  function hasWebCrypto() {
    return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim();
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToBase64(uint8) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < uint8.length; i += step) {
      bin += String.fromCharCode.apply(null, uint8.subarray(i, i + step));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // Detect whether user utterance is Korean, Chinese, or Japanese
  function detectInputLang(text) {
    const t = String(text || '').trim();
    if (!t) return 'ja';
    const hasHangul = /[\uac00-\ud7a3]/.test(t);
    const hasKana = /[\u3040-\u30ff]/.test(t);
    const hasCjk = /[\u4e00-\u9fff]/.test(t);
    if (hasHangul && !hasKana) return 'ko';
    if (hasCjk && !hasKana && !hasHangul) return 'zh';
    return 'ja';
  }

  // ---------- AES-GCM-256 + PBKDF2-SHA256 Encrypted Key Vault ----------
  async function deriveVaultKey(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: hexToBytes(saltHex),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function readRawVaultEnvelope() {
    try {
      const raw = localStorage.getItem(VAULT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeVaultData(parsed) {
    const def = createDefaultVaultData();
    const profiles = Array.isArray(parsed && parsed.profiles) ? parsed.profiles : def.profiles;
    const backupApi = { ...createDefaultBackupApi(), ...((parsed && parsed.backupApi) || {}) };
    const pinnedProfileId = (parsed && typeof parsed.pinnedProfileId === 'string') ? parsed.pinnedProfileId : '';
    const editLocked = !!(parsed && parsed.editLocked);

    let activeProfileId = (parsed && parsed.activeProfileId) || 'builtin';
    // If a pinned profile exists and is valid, always start with the pinned profile!
    if (pinnedProfileId) {
      const pinnedExists = pinnedProfileId === BACKUP_PROFILE_ID || profiles.some((p) => p.id === pinnedProfileId);
      if (pinnedExists) activeProfileId = pinnedProfileId;
    }

    return { activeProfileId, pinnedProfileId, editLocked, profiles, backupApi };
  }

  async function persistVault() {
    if (!vaultUnlocked || !vaultCryptoKey || !hasWebCrypto()) {
      throw new Error('암호화 금고가 잠겨 있습니다. 먼저 앱 비밀번호를 설정·잠금해제해 주세요.');
    }
    const iv = new Uint8Array(12);
    window.crypto.getRandomValues(iv);
    const plainBytes = new TextEncoder().encode(JSON.stringify(vaultData));
    const cipherBuf = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      vaultCryptoKey,
      plainBytes
    );
    const envelope = {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: 100000,
      saltHex: vaultSaltHex,
      ivHex: bytesToHex(iv),
      cipherB64: bytesToBase64(new Uint8Array(cipherBuf))
    };
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope));
  }

  async function unlockVaultWithPassword(password) {
    if (!hasWebCrypto()) {
      vaultUnlocked = false;
      vaultCryptoKey = null;
      renderAllAIViews();
      return;
    }
    const env = readRawVaultEnvelope();
    if (!env || !env.saltHex || !env.ivHex || !env.cipherB64) {
      const salt = new Uint8Array(16);
      window.crypto.getRandomValues(salt);
      vaultSaltHex = bytesToHex(salt);
      vaultCryptoKey = await deriveVaultKey(password, vaultSaltHex);
      vaultData = createDefaultVaultData();
      vaultUnlocked = true;
      await persistVault();
      renderAllAIViews();
      return;
    }
    try {
      const key = await deriveVaultKey(password, env.saltHex);
      const plainBuf = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexToBytes(env.ivHex) },
        key,
        base64ToBytes(env.cipherB64)
      );
      const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
      vaultSaltHex = env.saltHex;
      vaultCryptoKey = key;
      vaultData = normalizeVaultData(parsed);
      vaultUnlocked = true;
    } catch (err) {
      console.error('[KotonohaAI] Vault decrypt failed:', err);
      vaultUnlocked = false;
      vaultCryptoKey = null;
      toast('암호화 금고 복호화에 실패했습니다. 비밀번호를 다시 확인해 주세요.', 'error');
    }
    renderAllAIViews();
  }

  async function reencryptVaultWithNewPassword(newPassword, hadPasswordBefore) {
    if (!hasWebCrypto()) {
      renderAllAIViews();
      return;
    }
    const snapshot = vaultUnlocked
      ? JSON.parse(JSON.stringify(vaultData))
      : createDefaultVaultData();

    const salt = new Uint8Array(16);
    window.crypto.getRandomValues(salt);
    vaultSaltHex = bytesToHex(salt);
    vaultCryptoKey = await deriveVaultKey(newPassword, vaultSaltHex);
    vaultData = normalizeVaultData(snapshot);
    vaultUnlocked = true;
    await persistVault();
    renderAllAIViews();
    if (hadPasswordBefore) {
      toast('저장된 API 키 금고도 새 비밀번호로 안전하게 재암호화되었습니다.', 'info');
    } else {
      toast('앱 비밀번호 기반 AES-GCM-256 API 키 금고가 활성화되었습니다!', 'info');
    }
  }

  function clearLiveAudioBlobs() {
    liveAudioBlobUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch (e) {} });
    liveAudioBlobUrls.clear();
    if (activeReplayAudio) { try { activeReplayAudio.pause(); } catch (e) {} activeReplayAudio = null; }
  }

  function lockVaultAndClearMemory() {
    stopLiveSession(true);
    clearLiveAudioBlobs();
    vaultCryptoKey = null;
    vaultSaltHex = '';
    vaultUnlocked = false;
    vaultData = createDefaultVaultData();
    editingProfileId = null;
    renderAllAIViews();
  }

  function wipeVaultStorage() {
    lockVaultAndClearMemory();
    try { localStorage.removeItem(VAULT_STORAGE_KEY); } catch (e) {}
    try { localStorage.removeItem(PREFS_STORAGE_KEY); } catch (e) {}
    if (window.KotonohaScenes && window.KotonohaScenes.clearAllCustomImages) window.KotonohaScenes.clearAllCustomImages();
    prefs = { ...DEFAULT_PREFS };
    applyDisplayPrefs();
    renderAllAIViews();
  }

  function isBackupReady() {
    const b = vaultData && vaultData.backupApi;
    return !!(b && b.baseUrl && b.baseUrl.trim() && b.apiKey && b.apiKey.trim() && b.model && b.model.trim());
  }

  function getActiveProfile() {
    if (!vaultUnlocked) return null;
    const id = vaultData.activeProfileId;
    if (!id || id === 'builtin') return null;
    if (id === BACKUP_PROFILE_ID) {
      return isBackupReady() ? { ...vaultData.backupApi, id: BACKUP_PROFILE_ID, type: 'openai-compat' } : null;
    }
    return (vaultData.profiles || []).find((p) => p.id === id) || null;
  }

  function isProfileReady(p) {
    if (!p) return false;
    if (p.type === 'gemini-live') {
      return p.authMode === 'ephemeral' ? !!(p.tokenUrl && p.tokenUrl.trim()) : !!(p.apiKey && p.apiKey.trim());
    }
    if (p.type === 'openai-compat') {
      return !!(p.baseUrl && p.baseUrl.trim() && p.apiKey && p.apiKey.trim() && p.model && p.model.trim());
    }
    return false;
  }

  // ---------- System Prompt Builders (Scenario Mission vs Free Talk + KR/ZH support) ----------
  function isFreeTalkMode() {
    const b = bridge();
    const st = b && b.getState ? b.getState() : null;
    return !!(st && st.speakingMode === 'freetalk');
  }

  function buildLiveSystemPrompt() {
    const b = bridge();
    const sc = b && b.getScenario ? b.getScenario() : null;
    const st = b && b.getState ? b.getState() : { speakingRegister: 'polite', speakingMode: 'scenario', freeTalkTopic: '' };
    const isPolite = st.speakingRegister !== 'casual';
    const isFree = st.speakingMode === 'freetalk';
    const regRule = isPolite
      ? '丁寧語（です・ます調）で自然かつ親切に話してください。'
      : '親しい友達のようなタメ口（普通体）で自然に話してください。';

    const lenRule =
      prefs.liveReplyLength === 'short'
        ? '1回の返答は必ず短い1文だけにして、初級学習者が聞き取りやすいようにしてください。'
        : prefs.liveReplyLength === 'detailed'
        ? '1回の返答は2〜3文で少し詳しく自然に返し、会話が広がる質問を添えてください。'
        : '1回の返答は1〜2文で簡潔にし、会話が続くように自然な質問を返してください。';

    const speedRule =
      prefs.liveSpeedHint === 'slow'
        ? '発話スピードはゆっくり、はっきりとした発音で話してください。'
        : prefs.liveSpeedHint === 'natural'
        ? '実際のネイティブ同士のような自然なテンポとスピードで話してください。'
        : '学習者が聞き取りやすい標準的なスピードで自然に話してください。';

    if (isFree) {
      const topicLine = st.freeTalkTopic
        ? `希望テーマ: ${st.freeTalkTopic}（ただし学習者が別の話題を出したら自然に合わせてください）`
        : 'テーマ: 制限なし（どんな話題でも自由に楽しく会話してください）';
      return [
        'あなたは日本語学習アプリ「コトノハ」の自由フリートーク会話パートナー「ハルカ」です。',
        topicLine,
        `話し方: ${regRule}`,
        'ルール:',
        '1. 必ず自然な日本語（ja-JP）のみで話してください。韓国語や中国語・英語で読み上げないでください。',
        '2. 学習者が言葉に詰まって韓国語や中国語で話しかけても、意味を温かく理解して必ず自然な日本語で会話を続けてください。',
        '3. ' + lenRule,
        '4. ' + speedRule,
        '5. 学習者が途中で話し始めたらすぐ聞いて対応してください。'
      ].join('\n');
    }

    if (!sc) {
      return `あなたは日本語会話パートナーです。必ず自然な日本語（ja-JP）だけで応答してください。${regRule} ${lenRule} ${speedRule}`;
    }
    const keys = (sc.targetKeys || []).join('、');
    return [
      `あなたは日本語学習アプリ「コトノハ」のリアルタイム会話パートナー「${sc.partnerName}」です。`,
      `場面: ${sc.title}（${sc.level}）`,
      `学習者のミッション: ${sc.mission}`,
      keys ? `推奨表現: ${keys}` : '',
      `話し方: ${regRule}`,
      'ルール:',
      '1. 必ず自然な日本語（ja-JP）のみで話してください。韓国語や中国語・英語で返さないでください。',
      '2. 学習者が韓国語や中国語で話しても意図を理解し、日本語で優しく返答して会話を続けてください。',
      '3. ' + lenRule,
      '4. ' + speedRule,
      '5. 学習者が途中で話し始めたらすぐ聞いて対応してください。'
    ].filter(Boolean).join('\n');
  }

  function buildCompatSystemPrompt() {
    const b = bridge();
    const sc = b && b.getScenario ? b.getScenario() : null;
    const st = b && b.getState ? b.getState() : { speakingRegister: 'polite', speakingMode: 'scenario', freeTalkTopic: '' };
    const isPolite = st.speakingRegister !== 'casual';
    const isFree = st.speakingMode === 'freetalk';
    const regRule = isPolite
      ? '반드시 일본어 존댓말(丁寧語, です・ます체)로 답하세요.'
      : '반드시 일본어 친근한 반말(タメ口, 보통체)로 답하세요.';
    const lenRule =
      prefs.liveReplyLength === 'short'
        ? '일본어 응답(jp)은 아주 짧은 1문장으로만 작성하세요.'
        : prefs.liveReplyLength === 'detailed'
        ? '일본어 응답(jp)은 2~3문장으로 자연스럽고 풍부하게 작성하세요.'
        : '일본어 응답(jp)은 1~2문장으로 간결하게 작성하고 대화가 이어지도록 질문하세요.';

    const contextDesc = isFree
      ? `모드: 자유 프리토킹 (주제 제한 없음${st.freeTalkTopic ? ' · 현재 관심 주제: ' + st.freeTalkTopic : ''})\n역할: 친절한 일본인 회화 파트너 하루카`
      : (sc
          ? `모드: 상황별 미션\n역할: ${sc.partnerName}\n상황: ${sc.title} (${sc.level})\n학습자 미션: ${sc.mission}\n권장 표현: ${(sc.targetKeys || []).join(', ')}`
          : '역할: 일본어 회화 파트너');

    return [
      '당신은 일본어 회화 앱 코토노하(Kotonoha)의 AI 일본어 대화 파트너입니다.',
      contextDesc,
      regRule,
      lenRule,
      '사용자가 일본어가 막혀 한국어 또는 중국어로 말하거나 입력해도 뜻을 정확히 이해하고, AI 응답(jp)은 반드시 자연스러운 일본어로 이어서 답하세요.',
      '반드시 아래 JSON 형식만 출력하세요(마크다운 코드블록 금지):',
      '{"jp":"AI의 자연스러운 일본어 응답","ko":"AI 응답(jp)의 자연스러운 한국어 번역","user_sub":"사용자가 한국어 또는 중국어로 말했으면 현재 말투에 맞는 자연스러운 일본어 번역문만(한국어/중국어 설명 제외), 사용자가 일본어로 말했으면 자연스러운 한국어 번역문만","tip":"사용자가 일본어로 말했는데 더 자연스러운 원어민 표현이 있으면 짧은 교정 팁(한국어/중국어 입력이거나 이미 자연스러우면 빈 문자열)"}'
    ].join('\n');
  }

  // ---------- Background Bilingual Translation & KR/ZH->JP Tip Enrichment (for Gemini Live) ----------
  function findGeminiApiKeyForHelper() {
    if (!vaultUnlocked) return '';
    const act = getActiveProfile();
    if (act && act.type === 'gemini-live' && act.authMode !== 'ephemeral' && act.apiKey && act.apiKey.trim()) {
      return act.apiKey.trim();
    }
    const anyLive = (vaultData.profiles || []).find((p) => p.type === 'gemini-live' && p.authMode !== 'ephemeral' && p.apiKey && p.apiKey.trim());
    return anyLive ? anyLive.apiKey.trim() : '';
  }

  function findOpenAICompatForHelper() {
    if (!vaultUnlocked) return null;
    if (isBackupReady()) return vaultData.backupApi;
    return (vaultData.profiles || []).find((p) => p.type === 'openai-compat' && isProfileReady(p)) || null;
  }

  async function callFastHelperJson(promptText) {
    // Path 1: Google Gemini REST (gemini-3.5-flash-lite) using user's Gemini API key
    const gKey = findGeminiApiKeyForHelper();
    if (gKey) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FAST_TEXT_MODEL}:generateContent?key=${encodeURIComponent(gKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
            ? data.candidates[0].content.parts[0].text
            : '';
          if (raw) return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
        }
      } catch (e) {}
    }

    // Path 2: Fallback to Backup API or any configured OpenAI-compatible API
    const compat = findOpenAICompatForHelper();
    if (compat) {
      try {
        const endpoint = compat.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + compat.apiKey.trim() },
          body: JSON.stringify({
            model: compat.model.trim(),
            messages: [{ role: 'user', content: promptText }],
            temperature: 0.2
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          const raw = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
          if (raw) return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
        }
      } catch (e) {}
    }
    return null;
  }

  function canAutoTranslate() {
    return !!(findGeminiApiKeyForHelper() || findOpenAICompatForHelper());
  }

  async function enrichLiveTurnBilingual(chatKey, msgId, sender, rawText) {
    const b = bridge();
    if (!b || !b.updateAiTurn || !rawText || !rawText.trim()) return;
    const st = b.getState ? b.getState() : { speakingRegister: 'polite' };
    const regLabel = st.speakingRegister === 'casual' ? '일본어 반말(タメ口, 보통체)' : '일본어 존댓말(丁寧語, です/ます체)';

    if (sender === 'ai') {
      const prompt = `다음 일본어 문장을 자연스러운 한국어로 번역해 JSON으로만 답하세요. {"ko":"한국어 번역"}\n문장: ${rawText}`;
      const res = await callFastHelperJson(prompt);
      const ko = (res && typeof res.ko === 'string' && res.ko.trim()) ? res.ko.trim() : '';
      b.updateAiTurn(chatKey, msgId, { ko: ko || '(한국어 번역 불러오기 실패)', subLang: 'ko', pendingKo: false, streaming: false });
      return;
    }

    // sender === 'user': KR/ZH -> Japanese only (🇯🇵), JP -> Korean (🇰🇷)
    const lang = detectInputLang(rawText);
    if (lang === 'ko' || lang === 'zh') {
      const srcLabel = lang === 'ko' ? '한국어' : '중국어';
      const prompt = `다음 ${srcLabel} 발화를 실제 일본인이 쓰는 자연스러운 ${regLabel} 일본어 문장 1개로만 번역해 JSON으로 답하세요(설명·괄호·한국어 금지): {"jp":"자연스러운 일본어 번역"}\n발화: ${rawText}`;
      const res = await callFastHelperJson(prompt);
      const jpTrans = (res && typeof res.jp === 'string' && res.jp.trim()) ? res.jp.trim() : '';
      b.updateAiTurn(chatKey, msgId, {
        ko: jpTrans ? ('🇯🇵 ' + jpTrans) : '',
        subLang: 'ja',
        pendingKo: false
      });
      return;
    }

    const prompt = `사용자가 일본어로 말했습니다. JSON으로만 답하세요: {"ko":"위 일본어의 자연스러운 한국어 번역","tip":"더 자연스러운 원어민 일본어 교정 팁(이미 자연스러우면 빈 문자열)"}\n발화: ${rawText}`;
    const res = await callFastHelperJson(prompt);
    const ko = (res && typeof res.ko === 'string' && res.ko.trim()) ? ('🇰🇷 ' + res.ko.trim()) : '';
    const tip = (res && typeof res.tip === 'string') ? res.tip.trim() : '';
    b.updateAiTurn(chatKey, msgId, { ko, subLang: 'ko', tip, pendingKo: false });
  }

  function translateUserTurnIfPossible(chatKey, msgId, rawText) {
    if (!canAutoTranslate()) return false;
    enrichLiveTurnBilingual(chatKey, msgId, 'user', rawText);
    return true;
  }

  function splitMoraeClient(kana) {
    const small = new Set(['ゃ','ゅ','ょ','ぁ','ぃ','ぅ','ぇ','ぉ','ャ','ュ','ョ','ァ','ィ','ゥ','ェ','ォ']);
    const clean = String(kana || '').replace(/[・\s（）()\-～〜]/g, '');
    const out = [];
    for (const ch of Array.from(clean)) {
      if (small.has(ch) && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out.slice(0, 9);
  }

  async function generateScenarioVocabWithAI(sc, customTopic, existingWords) {
    if (!vaultUnlocked || !canAutoTranslate()) {
      throw new Error('⚙️ 설정 → AI · API 설정에서 비밀번호 잠금 해제 후 API 키를 먼저 저장해 주세요.');
    }
    const existStr = (existingWords || []).slice(0, 40).join(', ');
    const topicLine = customTopic
      ? `세부 집중 주제: ${customTopic}`
      : '세부 집중 주제: 실제 일본 현장에서 꼭 쓰이는 소품·메뉴·요청·돌발 표현';

    const prompt = [
      `일본어 회화 앱 코토노하의 Day ${sc.day} 「${sc.title}」 에피소드용 실전 일본어 단어 8개를 새로 만들어 주세요.`,
      topicLine,
      `이미 등록된 단어(중복 금지): ${existStr}`,
      '반드시 아래 JSON 형식만 출력하세요(마크다운 금지):',
      '{"items":[{"word":"일본어 표기","kana":"히라가나/가타카나 읽기","pitch":0,"level":"N4","cat":"짧은 주제태그(예:음료/소품/요청/증상)","meaning":"명확한 한국어 뜻","exPlain":"실전 일본어 예문","exKo":"예문 한국어 번역"}]}'
    ].join('\n');

    const res = await callFastHelperJson(prompt);
    const arr = res && Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);
    if (!arr.length) throw new Error('AI 응답에서 유효한 어휘 목록을 받지 못했습니다. 잠시 후 다시 시도해 주세요.');

    const existSet = new Set(existingWords || []);
    const out = [];
    const ts = Date.now();
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!it || !it.word || !it.meaning) continue;
      const w = String(it.word).trim();
      if (!w || existSet.has(w)) continue;
      existSet.add(w);
      const k = String(it.kana || w).trim();
      const hasKanji = /[\u4e00-\u9fff]/.test(w);
      const exP = String(it.exPlain || `${w}をお願いします。`).trim();
      out.push({
        id: `ai_${sc.id}_${ts}_${i}`,
        word: w,
        ruby: hasKanji ? `<ruby>${w}<rt>${k}</rt></ruby>` : w,
        kana: k,
        pitch: Math.max(0, Math.min(8, parseInt(it.pitch, 10) || 0)),
        morae: splitMoraeClient(k),
        level: ['N5','N4','N3','N2'].includes(it.level) ? it.level : 'N4',
        cat: String(it.cat || 'AI 확장').trim().slice(0, 10),
        meaning: String(it.meaning).trim(),
        exJp: exP,
        exPlain: exP,
        exKo: String(it.exKo || it.meaning).trim(),
        isAi: true
      });
    }
    if (!out.length) throw new Error('중복되지 않은 새 단어를 찾지 못했습니다. 다른 세부 주제를 입력해 보세요.');
    return out;
  }

  // ---------- PCM Audio Utilities (16kHz In / 24kHz Out + WAV Replay + Earphone Bridge) ----------
  function downsampleTo16k(float32, inputRate) {
    if (inputRate === 16000) return float32;
    const ratio = inputRate / 16000;
    const outLen = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = float32[idx] || 0;
      const s1 = float32[idx + 1] !== undefined ? float32[idx + 1] : s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }

  function floatToInt16LE(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  function base64ToInt16(b64) {
    const bytes = base64ToBytes(b64);
    return new Int16Array(bytes.buffer);
  }

  function buildWavBlobFromInt16Chunks(chunks, sampleRate) {
    let totalSamples = 0;
    for (const c of chunks) totalSamples += c.length;
    if (!totalSamples) return null;
    const dataBytes = totalSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    let offset = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        view.setInt16(offset, c[i], true);
        offset += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function replayLiveAudio(audioId) {
    const url = liveAudioBlobUrls.get(audioId);
    if (!url) return false;
    try {
      const b = bridge();
      if (b && b.stopSpeech) b.stopSpeech();
      if (activeReplayAudio) { try { activeReplayAudio.pause(); } catch (e) {} }
      const el = new Audio(url);
      if (prefs.audioOutputId && typeof el.setSinkId === 'function') {
        el.setSinkId(prefs.audioOutputId).catch(() => {});
      }
      activeReplayAudio = el;
      el.play().catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  async function applySinkToPlayback(sinkId) {
    if (playAudioEl && typeof playAudioEl.setSinkId === 'function') {
      try { await playAudioEl.setSinkId(sinkId || ''); } catch (e) {}
    }
    if (playCtx && typeof playCtx.setSinkId === 'function') {
      try { await playCtx.setSinkId(sinkId || ''); } catch (e) {}
    }
  }

  function ensurePlayAudioElement() {
    if (!playAudioEl) {
      playAudioEl = document.getElementById('gemini-live-audio-el');
      if (!playAudioEl) {
        playAudioEl = document.createElement('audio');
        playAudioEl.id = 'gemini-live-audio-el';
        playAudioEl.autoplay = true;
        playAudioEl.playsInline = true;
        playAudioEl.style.display = 'none';
        document.body.appendChild(playAudioEl);
      }
    }
    return playAudioEl;
  }

  function ensurePlayContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!playCtx || playCtx.state === 'closed') {
      playCtx = new AC();
      nextPlayTime = playCtx.currentTime;
      playDestNode = null;

      // Route WebAudio through HTML <audio> MediaStream bridge for better earphone/Bluetooth & setSinkId compatibility
      if (prefs.useAudioElementBridge && typeof playCtx.createMediaStreamDestination === 'function') {
        try {
          playDestNode = playCtx.createMediaStreamDestination();
          const el = ensurePlayAudioElement();
          el.srcObject = playDestNode.stream;
          if (prefs.audioOutputId && typeof el.setSinkId === 'function') {
            el.setSinkId(prefs.audioOutputId).catch(() => {});
          }
          el.play().catch(() => {
            // Fallback to direct destination if autoplay is blocked
            playDestNode = null;
          });
        } catch (e) {
          playDestNode = null;
        }
      } else if (prefs.audioOutputId && typeof playCtx.setSinkId === 'function') {
        playCtx.setSinkId(prefs.audioOutputId).catch(() => {});
      }
    }
    if (playCtx.state === 'suspended') playCtx.resume().catch(() => {});
    if (playDestNode && playAudioEl && playAudioEl.paused) {
      playAudioEl.play().catch(() => { playDestNode = null; });
    }
  }

  function stopPlaybackQueue() {
    activeSources.forEach((src) => { try { src.stop(); } catch (e) {} });
    activeSources.clear();
    if (playCtx) nextPlayTime = playCtx.currentTime;
  }

  function enqueuePcm24k(b64) {
    if (!b64) return;
    ensurePlayContext();
    const int16 = base64ToInt16(b64);
    if (!int16.length) return;

    // Save chunk for instant native-voice replay button
    liveAiPcmChunks.push(int16);

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buf = playCtx.createBuffer(1, float32.length, 24000);
    buf.getChannelData(0).set(float32);

    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playDestNode || playCtx.destination);

    const now = playCtx.currentTime;
    const startAt = Math.max(now + 0.02, nextPlayTime);
    src.start(startAt);
    nextPlayTime = startAt + buf.duration;

    activeSources.add(src);
    src.onended = () => {
      activeSources.delete(src);
      if (activeSources.size === 0 && isLiveActive) {
        setLiveStatusUI(isMuted ? 'muted' : 'listening', isMuted
          ? '마이크 음소거됨 (버튼을 눌러 말하기)'
          : '듣는 중 🎙️ (말을 걸면 언제든 끼어들기 가능)');
      }
    };
  }

  // ---------- Audio Device Enumeration (Earphones / Speakers / Mic) ----------
  async function refreshAudioDeviceSelectors(requestPermIfNeeded) {
    const outSel = document.getElementById('sp-audio-output-select');
    const inSel = document.getElementById('sp-audio-input-select');
    const noteEl = document.getElementById('sp-audio-device-note');
    if (!outSel || !inSel) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      if (noteEl) noteEl.textContent = '이 브라우저는 장치 목록 조회를 지원하지 않습니다 (시스템 기본 출력 사용).';
      return;
    }

    if (requestPermIfNeeded && navigator.mediaDevices.getUserMedia) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
      } catch (e) {}
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      const inputs = devices.filter((d) => d.kind === 'audioinput');

      const supportsSink = ('setSinkId' in HTMLMediaElement.prototype) || (typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype);

      outSel.innerHTML = '<option value="">시스템 기본 출력 (자동 · 이어폰 우선 브리지)</option>' +
        outputs.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || ('출력 장치 ' + (i + 1)))}</option>`).join('');
      outSel.value = outputs.some((d) => d.deviceId === prefs.audioOutputId) ? prefs.audioOutputId : '';
      outSel.disabled = !supportsSink;

      inSel.innerHTML = '<option value="">시스템 기본 마이크</option>' +
        inputs.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || ('마이크 ' + (i + 1)))}</option>`).join('');
      inSel.value = inputs.some((d) => d.deviceId === prefs.audioInputId) ? prefs.audioInputId : '';

      if (noteEl) {
        noteEl.textContent = supportsSink
          ? `감지된 출력 장치 ${outputs.length}개 · 마이크 ${inputs.length}개 (블루투스 이어폰 사용 시 출력을 이어폰으로, 마이크를 내장 마이크로 지정하면 끊김·스피커 전환이 줄어듭니다)`
          : '이 환경(일부 모바일 WebView/Safari)은 개별 출력 선택(setSinkId)이 제한되어 <audio> 이어폰 브리지 모드로 자동 동작합니다.';
      }
    } catch (e) {
      if (noteEl) noteEl.textContent = '장치 목록을 불러오지 못했습니다. 마이크 권한 허용 후 다시 시도해 주세요.';
    }
  }

  // ---------- Failover Helper (Primary -> Backup API) ----------
  function activateBackupFailover(reasonText) {
    if (!vaultUnlocked || !vaultData.backupApi || !vaultData.backupApi.enabled || !isBackupReady()) {
      return false;
    }
    vaultData.activeProfileId = BACKUP_PROFILE_ID;
    // Note: Keep pinnedProfileId untouched so user's primary pin stays preserved for next restart!
    renderAllAIViews();
    const bName = vaultData.backupApi.name || '예비 API';
    setLiveStatusUI('idle', `🛡️ 자동 전환됨 · ${bName} (${vaultData.backupApi.model}) 사용 중`);
    toast(`⚠️ 주 API 오류(${reasonText}) → 예비 API「${bName}」로 자동 전환했습니다! 계속 대화하세요.`, 'warn');
    return true;
  }

  // ---------- Gemini Live Session ----------
  async function resolveGeminiLiveWsUrl(profile) {
    if (profile.authMode === 'ephemeral') {
      const endpoint = (profile.tokenUrl || '').trim();
      if (!endpoint) throw new Error('임시 토큰 발급 서버 URL을 입력해 주세요.');
      const resp = await fetch(endpoint, { method: 'POST' });
      if (!resp.ok) throw new Error('임시 토큰 발급 실패 (HTTP ' + resp.status + ')');
      const data = await resp.json();
      const token = data.token || data.name || data.access_token || '';
      if (!token) throw new Error('토큰 응답에 token/name 필드가 없습니다.');
      return (
        'wss://generativelanguage.googleapis.com/ws/' +
        'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained' +
        '?access_token=' + encodeURIComponent(token)
      );
    }
    const key = (profile.apiKey || '').trim();
    if (!key) throw new Error('선택한 Gemini Live 프로필에 API 키가 비어 있습니다.');
    return (
      'wss://generativelanguage.googleapis.com/ws/' +
      'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
      '?key=' + encodeURIComponent(key)
    );
  }

  async function startLiveSession() {
    if (isLiveActive) return;
    if (!vaultUnlocked) {
      toast('엄격 보안 모드: 먼저 ⚙️ 설정에서 앱 비밀번호를 등록하고 API 키를 입력해 주세요.', 'warn');
      openSettingsPage('security');
      return;
    }
    const profile = getActiveProfile();
    if (!profile || profile.type !== 'gemini-live') {
      toast('회화 엔진을 [Gemini Live] 프로필로 선택한 뒤 시작해 주세요.', 'warn');
      return;
    }
    if (!isProfileReady(profile)) {
      toast('⚙️ 설정 → AI · API 설정에서 Gemini API 키를 먼저 저장해 주세요.', 'warn');
      openSettingsPage('ai');
      return;
    }

    const b = bridge();
    if (b && b.stopSpeech) b.stopSpeech();

    setLiveStatusUI('connecting', 'Gemini Live 연결 중…');
    updateLiveButtonsUI(true);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('이 환경에서는 마이크 스트리밍(getUserMedia)을 사용할 수 없습니다.');
      }

      // 1. Request microphone FIRST (prevents Chromium Bluetooth AudioContext buffer mismatch!)
      const audioConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (prefs.audioInputId) {
        audioConstraints.deviceId = { ideal: prefs.audioInputId };
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (micErr) {
        if (prefs.audioInputId) {
          delete audioConstraints.deviceId;
          micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        } else {
          throw micErr;
        }
      }

      // 2. Initialize playback context + <audio> earphone bridge AFTER getUserMedia succeeds
      if (playCtx) { try { playCtx.close(); } catch (e) {} playCtx = null; playDestNode = null; }
      ensurePlayContext();
      refreshAudioDeviceSelectors(false);

      // 3. Open WebSocket
      const wsUrl = await resolveGeminiLiveWsUrl(profile);
      ws = new WebSocket(wsUrl);
      isLiveActive = true;
      isSetupComplete = false;
      isMuted = !!prefs.liveStartMuted;
      pendingUserText = '';
      pendingAiText = '';
      liveAiBubbleRef = null;
      liveAiPcmChunks = [];

      ws.onopen = () => {
        const inputTransCfg = profile.sendLangHint ? { languageCodes: ['ja-JP'] } : {};
        const setupMsg = {
          setup: {
            model: 'models/' + (profile.model || 'gemini-3.1-flash-live-preview').trim(),
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: profile.voiceName || 'Kore' }
                }
              }
            },
            systemInstruction: {
              parts: [{ text: buildLiveSystemPrompt() }]
            },
            inputAudioTranscription: inputTransCfg,
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} }
          }
        };
        ws.send(JSON.stringify(setupMsg));
      };

      ws.onmessage = async (ev) => {
        try {
          const text = ev.data instanceof Blob ? await ev.data.text() : String(ev.data);
          handleLiveServerMsg(JSON.parse(text));
        } catch (err) {
          console.error('[KotonohaAI] Live parse error:', err);
        }
      };

      ws.onerror = () => {
        toast('Gemini Live WebSocket 연결 오류가 발생했습니다.', 'error');
      };

      ws.onclose = (ev) => {
        const wasActive = isLiveActive;
        cleanupLiveSession();
        if (wasActive && ev.code !== 1000) {
          const reason = `코드 ${ev.code}${ev.reason ? ': ' + ev.reason : ''}`;
          if (!activateBackupFailover(reason)) {
            setLiveStatusUI('idle', `세션 종료 (${reason})`);
            toast(`실시간 세션이 종료되었습니다 (${reason})`, 'warn');
          }
        } else {
          setLiveStatusUI('idle', '대기 중 · 버튼을 눌러 일본어 실시간 대화를 시작하세요');
        }
      };
    } catch (err) {
      cleanupLiveSession();
      const errText = err && err.message ? err.message : '연결 실패';
      if (!activateBackupFailover(errText)) {
        setLiveStatusUI('idle', '연결 실패');
        toast(errText, 'error');
      }
    }
  }

  function startMicCapture() {
    if (!micStream) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    captureCtx = new AC();
    captureSource = captureCtx.createMediaStreamSource(micStream);
    captureProc = captureCtx.createScriptProcessor(4096, 1, 1);

    const silentGain = captureCtx.createGain();
    silentGain.gain.value = 0;

    pcmChunkBuffer = [];
    pcmChunkSamples = 0;
    const TARGET_SAMPLES = 1600; // 100ms @ 16kHz

    captureProc.onaudioprocess = (ev) => {
      if (!isLiveActive || !isSetupComplete || isMuted || !ws || ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const down = downsampleTo16k(input, captureCtx.sampleRate);
      const int16 = floatToInt16LE(down);
      pcmChunkBuffer.push(int16);
      pcmChunkSamples += int16.length;

      if (pcmChunkSamples >= TARGET_SAMPLES) {
        const merged = new Int16Array(pcmChunkSamples);
        let offset = 0;
        for (const chunk of pcmChunkBuffer) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        pcmChunkBuffer = [];
        pcmChunkSamples = 0;

        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: 'audio/pcm;rate=16000',
              data: bytesToBase64(new Uint8Array(merged.buffer))
            }
          }
        }));
      }
    };

    captureSource.connect(captureProc);
    captureProc.connect(silentGain);
    silentGain.connect(captureCtx.destination);
  }

  function commitPendingUserUtterance() {
    const uText = pendingUserText.trim();
    if (!uText) return;
    pendingUserText = '';
    const b = bridge();
    if (!b || !b.appendAiTurn) return;
    const lang = detectInputLang(uText);
    const subLang = (lang === 'ko' || lang === 'zh') ? 'ja' : 'ko';
    const ref = b.appendAiTurn('user', uText, '', '', { subLang, pendingKo: true });
    if (ref && ref.id) {
      enrichLiveTurnBilingual(ref.chatKey, ref.id, 'user', uText);
    }
  }

  function finalizeLiveAiTurn(interrupted) {
    const b = bridge();
    const text = pendingAiText.trim();
    const chunks = liveAiPcmChunks;
    pendingAiText = '';
    liveAiPcmChunks = [];

    let audioId = '';
    if (chunks.length > 0) {
      const wavBlob = buildWavBlobFromInt16Chunks(chunks, 24000);
      if (wavBlob) {
        audioId = 'live_wav_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        liveAudioBlobUrls.set(audioId, URL.createObjectURL(wavBlob));
      }
    }

    if (liveAiBubbleRef && b && b.updateAiTurn) {
      const ref = liveAiBubbleRef;
      liveAiBubbleRef = null;
      const finalJp = text ? (interrupted ? text + ' …' : text) : '(음성 응답)';
      b.updateAiTurn(ref.chatKey, ref.id, {
        jp: finalJp,
        streaming: false,
        pendingKo: !!text,
        audioId
      });
      if (text) enrichLiveTurnBilingual(ref.chatKey, ref.id, 'ai', text);
    } else if (text && b && b.appendAiTurn) {
      const ref = b.appendAiTurn('ai', interrupted ? text + ' …' : text, '', '', {
        pendingKo: true,
        streaming: false,
        audioId
      });
      if (ref && ref.id) enrichLiveTurnBilingual(ref.chatKey, ref.id, 'ai', text);
    }
    renderLiveSubtitle('', '');
  }

  function syncMuteButtonUI() {
    const muteBtn = document.getElementById('btn-ai-live-mute');
    if (!muteBtn) return;
    muteBtn.textContent = isMuted ? '🔇 음소거됨' : '🎙️ 마이크 켜짐';
    muteBtn.className = isMuted
      ? 'px-3 py-2 rounded-xl bg-slate-200 text-slate-700 text-xs font-semibold transition'
      : 'px-3 py-2 rounded-xl bg-white border border-brand-200 text-brand-700 text-xs font-semibold transition';
  }

  function handleLiveServerMsg(msg) {
    if (msg.setupComplete) {
      isSetupComplete = true;
      startMicCapture();
      syncMuteButtonUI();
      setLiveStatusUI(isMuted ? 'muted' : 'listening', isMuted
        ? '연결 완료 (시작 음소거 설정됨 · 마이크 버튼을 켜고 말해 보세요)'
        : '연결 완료! 일본어로 자유롭게 말해 보세요 🎙️');
      toast('Gemini Live 실시간 일본어 대화가 시작되었습니다!', 'info');

      const b = bridge();
      const sc = b && b.getScenario ? b.getScenario() : null;
      const st = b && b.getState ? b.getState() : null;
      const intro = isFreeTalkMode()
        ? (st && st.freeTalkTopic
            ? `テーマ「${st.freeTalkTopic}」について日本語で短く挨拶して会話を始めてください。`
            : '自由フリートークを始めましょう。日本語で短く挨拶して質問してください。')
        : (sc
            ? `場面「${sc.title}」の最初の一言を日本語で短く話しかけて始めてください。`
            : '日本語で短く挨拶して会話を始めてください。');
      ws.send(JSON.stringify({ realtimeInput: { text: intro } }));
      return;
    }

    if (msg.goAway) toast('세션 만료 임박 알림을 받았습니다. 곧 재연결이 필요합니다.', 'warn');

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      stopPlaybackQueue();
      setLiveStatusUI('listening', '끼어들기 감지 ⚡ 듣는 중…');
      finalizeLiveAiTurn(true);
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      pendingUserText += sc.inputTranscription.text;
      renderLiveSubtitle(pendingUserText, pendingAiText);
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      // Commit user bubble once AI begins answering
      if (pendingUserText.trim()) commitPendingUserUtterance();

      pendingAiText += sc.outputTranscription.text;
      renderLiveSubtitle(pendingUserText, pendingAiText);

      // Stream AI Japanese text live right inside #chat-messages WHILE voice plays!
      const b = bridge();
      if (b && b.appendAiTurn && b.updateAiTurn) {
        if (!liveAiBubbleRef) {
          liveAiBubbleRef = b.appendAiTurn('ai', pendingAiText, '', '', {
            streaming: true,
            pendingKo: true,
            skipPersist: true
          });
        } else {
          b.updateAiTurn(liveAiBubbleRef.chatKey, liveAiBubbleRef.id, {
            jp: pendingAiText,
            streaming: true,
            pendingKo: true,
            skipPersist: true
          });
        }
      }
    }

    if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) {
          setLiveStatusUI('speaking', 'AI 원어민 응답 중 🔊 (말을 걸면 즉시 끼어들기)');
          enqueuePcm24k(part.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      if (pendingUserText.trim()) commitPendingUserUtterance();
      finalizeLiveAiTurn(false);
    }
  }

  function toggleMute() {
    if (!isLiveActive) return;
    isMuted = !isMuted;
    if (isMuted && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }
    syncMuteButtonUI();
    setLiveStatusUI(isMuted ? 'muted' : 'listening', isMuted ? '마이크 일시 음소거됨' : '듣는 중 🎙️');
  }

  function stopLiveSession(silent) {
    if (!silent) {
      if (pendingUserText.trim()) commitPendingUserUtterance();
      finalizeLiveAiTurn(false);
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(1000, 'user_ended'); } catch (e) {}
    }
    cleanupLiveSession();
    if (!silent) setLiveStatusUI('idle', '실시간 대화를 종료했습니다');
  }

  function cleanupLiveSession() {
    isLiveActive = false;
    isSetupComplete = false;
    isMuted = false;
    liveAiBubbleRef = null;
    liveAiPcmChunks = [];
    stopPlaybackQueue();
    if (captureProc) { try { captureProc.disconnect(); } catch (e) {} captureProc = null; }
    if (captureSource) { try { captureSource.disconnect(); } catch (e) {} captureSource = null; }
    if (captureCtx) { try { captureCtx.close(); } catch (e) {} captureCtx = null; }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    ws = null;
    updateLiveButtonsUI(false);
    renderLiveSubtitle('', '');
  }

  // ---------- OpenAI-Compatible Turn-Based Chat (With Automatic Backup Failover!) ----------
  function parseCompatJsonReply(raw) {
    const trimmed = String(raw || '').trim();
    const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj.jp === 'string' && obj.jp.trim()) {
        return {
          jp: obj.jp.trim(),
          ko: typeof obj.ko === 'string' ? obj.ko.trim() : '',
          user_sub: typeof obj.user_sub === 'string' ? obj.user_sub.trim() : (typeof obj.user_ko === 'string' ? obj.user_ko.trim() : ''),
          tip: typeof obj.tip === 'string' ? obj.tip.trim() : ''
        };
      }
    } catch (e) {}
    return { jp: trimmed || 'すみません、もう一度お願いできますか？', ko: '(커스텀 AI 응답)', user_sub: '', tip: '' };
  }

  async function requestCompatCompletion(profile, messages) {
    const endpoint = profile.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + profile.apiKey.trim()
      },
      body: JSON.stringify({ model: profile.model.trim(), messages, temperature: 0.7 })
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${errBody.slice(0, 120)}`);
    }
    const data = await resp.json();
    return data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  }

  async function sendToOpenAICompat(profile, userText) {
    const b = bridge();
    if (!b) return;
    if (isCompatBusy) {
      toast('이전 AI 응답을 기다리는 중입니다…', 'info');
      return;
    }
    isCompatBusy = true;

    const st = b.getState();
    const chatKey = b.getActiveChatKey ? b.getActiveChatKey() : b.getScenario().id;
    const lang = detectInputLang(userText);
    const subLang = (lang === 'ko' || lang === 'zh') ? 'ja' : 'ko';
    const userRef = b.appendAiTurn('user', userText, '', '', { subLang, pendingKo: true });
    setLiveStatusUI('connecting', `${profile.name} 응답 생성 중…`);

    const history = (st.chatByScenario[chatKey] || []).slice(-10);
    const messages = [{ role: 'system', content: buildCompatSystemPrompt() }];
    for (const m of history) {
      messages.push({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.jp });
    }

    let usedProfile = profile;
    let content = '';

    try {
      try {
        content = await requestCompatCompletion(profile, messages);
      } catch (primaryErr) {
        // Automatic failover to Backup API if primary fails and we aren't already on Backup API!
        if (profile.id !== BACKUP_PROFILE_ID && vaultData.backupApi && vaultData.backupApi.enabled && isBackupReady()) {
          const bk = { ...vaultData.backupApi, id: BACKUP_PROFILE_ID, type: 'openai-compat' };
          setLiveStatusUI('connecting', `주 API 오류 → 예비 API(${bk.name})로 자동 전환 중…`);
          content = await requestCompatCompletion(bk, messages);
          usedProfile = bk;
          vaultData.activeProfileId = BACKUP_PROFILE_ID;
          renderAllAIViews();
          toast(`⚠️ 주 API 오류 → 예비 API「${bk.name}」로 자동 전환되어 응답했습니다!`, 'warn');
        } else {
          throw primaryErr;
        }
      }

      const parsed = parseCompatJsonReply(content);
      if (userRef && userRef.id && b.updateAiTurn) {
        const prefix = subLang === 'ja' ? '🇯🇵 ' : '🇰🇷 ';
        const subText = parsed.user_sub ? (parsed.user_sub.startsWith('🇯🇵') || parsed.user_sub.startsWith('🇰🇷') ? parsed.user_sub : prefix + parsed.user_sub) : '';
        b.updateAiTurn(userRef.chatKey, userRef.id, {
          ko: subText,
          subLang,
          tip: parsed.tip || '',
          pendingKo: false
        });
      }

      b.appendAiTurn('ai', parsed.jp, parsed.ko || '(커스텀 AI 응답)', '');
      setLiveStatusUI('idle', `턴제 AI 연결됨 · ${usedProfile.name} (${usedProfile.model})`);
      if (st.autoTts && !st.commuteSilent && b.speakJapanese) {
        b.speakJapanese(parsed.jp, 1.0, 1.05);
      }
    } catch (err) {
      console.error('[KotonohaAI] OpenAI-compat error:', err);
      if (userRef && userRef.id && b.updateAiTurn) {
        b.updateAiTurn(userRef.chatKey, userRef.id, { pendingKo: false });
      }
      setLiveStatusUI('idle', 'API 호출 오류 (네트워크/키/CORS 확인)');
      toast('커스텀 AI 호출 실패: ' + (err.message || 'CORS 또는 네트워크 오류'), 'error');
    } finally {
      isCompatBusy = false;
    }
  }

  function handleChatInput(text) {
    if (isLiveActive && isSetupComplete && ws && ws.readyState === WebSocket.OPEN) {
      const b = bridge();
      const lang = detectInputLang(text);
      const subLang = (lang === 'ko' || lang === 'zh') ? 'ja' : 'ko';
      if (b && b.appendAiTurn) {
        const ref = b.appendAiTurn('user', text, '', '', { subLang, pendingKo: true });
        if (ref && ref.id) enrichLiveTurnBilingual(ref.chatKey, ref.id, 'user', text);
      }
      ws.send(JSON.stringify({ realtimeInput: { text } }));
      return true;
    }
    const profile = getActiveProfile();
    if (profile && profile.type === 'openai-compat' && isProfileReady(profile)) {
      sendToOpenAICompat(profile, text);
      return true;
    }
    return false;
  }

  // ---------- Connection Test Tool ----------
  async function testProfileConnection(profile) {
    const t0 = performance.now();
    if (profile.type === 'gemini-live') {
      const wsUrl = await resolveGeminiLiveWsUrl(profile);
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { testWs.close(); } catch (e) {}
          reject(new Error('연결 시간 초과 (8초). 네트워크 또는 모델명을 확인하세요.'));
        }, 8000);

        const testWs = new WebSocket(wsUrl);
        testWs.onopen = () => {
          testWs.send(JSON.stringify({
            setup: {
              model: 'models/' + (profile.model || 'gemini-3.1-flash-live-preview').trim(),
              generationConfig: { responseModalities: ['AUDIO'] }
            }
          }));
        };
        testWs.onmessage = async (ev) => {
          try {
            const raw = ev.data instanceof Blob ? await ev.data.text() : String(ev.data);
            const parsed = JSON.parse(raw);
            if (parsed.setupComplete && !done) {
              done = true;
              clearTimeout(timer);
              const ms = Math.round(performance.now() - t0);
              try { testWs.close(1000, 'probe_ok'); } catch (e) {}
              resolve(`Gemini Live WebSocket 연결 성공 ✅ (${ms}ms)`);
            }
          } catch (e) {}
        };
        testWs.onerror = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new Error('WebSocket 연결 실패. API 키 또는 네트워크를 확인하세요.'));
        };
        testWs.onclose = (ev) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new Error(`서버가 연결을 닫았습니다 (코드 ${ev.code}${ev.reason ? ': ' + ev.reason : ''})`));
        };
      });
    }

    if (profile.type === 'openai-compat') {
      const base = (profile.baseUrl || '').trim().replace(/\/+$/, '');
      const key = (profile.apiKey || '').trim();
      const model = (profile.model || '').trim();
      if (!base || !key || !model) throw new Error('Base URL, API 키, 모델명을 모두 입력해 주세요.');
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 })
      });
      const ms = Math.round(performance.now() - t0);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 140)}`);
      }
      return `OpenAI 호환 API 연결 성공 ✅ (${ms}ms · ${model})`;
    }
    throw new Error('지원하지 않는 프로필 형식입니다.');
  }

  // ---------- Daily Learning Reminder (Capacitor Native + Web Notification) ----------
  function getNativeLocalNotifPlugin() {
    const b = bridge();
    return b && b.getCapPlugin ? b.getCapPlugin('LocalNotifications') : null;
  }

  async function syncDailyReminderSchedule(showFeedback) {
    const nativeNotif = getNativeLocalNotifPlugin();
    const parts = String(prefs.reminderTime || '21:00').split(':');
    const hour = Math.max(0, Math.min(23, parseInt(parts[0], 10) || 21));
    const minute = Math.max(0, Math.min(59, parseInt(parts[1], 10) || 0));
    const bodyText = (prefs.reminderMessage || DEFAULT_PREFS.reminderMessage).trim();

    if (nativeNotif) {
      try {
        await nativeNotif.cancel({ notifications: [{ id: REMINDER_NOTIF_ID }] }).catch(() => {});
        if (prefs.reminderEnabled) {
          const perm = await nativeNotif.requestPermissions();
          if (perm && perm.display !== 'granted') {
            prefs.reminderEnabled = false;
            savePrefs();
            if (showFeedback) toast('기기 설정에서 알림 권한을 허용해 주세요.', 'warn');
            return;
          }
          await nativeNotif.schedule({
            notifications: [{
              id: REMINDER_NOTIF_ID,
              title: '코토노하 매일 12분 일본어',
              body: bodyText,
              schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true }
            }]
          });
          if (showFeedback) toast(`매일 ${prefs.reminderTime} 네이티브 앱 알림이 예약되었습니다 ✅`, 'info');
        } else if (showFeedback) {
          toast('일일 학습 알림이 해제되었습니다.', 'info');
        }
      } catch (err) {
        if (showFeedback) toast('네이티브 알림 예약 오류: ' + (err.message || err), 'warn');
      }
      return;
    }

    if (prefs.reminderEnabled) {
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (e) {}
      }
      if ('Notification' in window && Notification.permission === 'denied') {
        if (showFeedback) toast('브라우저 알림이 차단되어 있습니다. 주소창 권한에서 허용해 주세요.', 'warn');
      } else if (showFeedback) {
        toast(`매일 ${prefs.reminderTime} 알림이 저장되었습니다 (웹은 탭 열림 시 동작 · APK는 백그라운드 동작)`, 'info');
      }
    } else if (showFeedback) {
      toast('일일 학습 알림이 해제되었습니다.', 'info');
    }
  }

  async function sendTestReminderNotification() {
    const bodyText = (prefs.reminderMessage || DEFAULT_PREFS.reminderMessage).trim();
    const nativeNotif = getNativeLocalNotifPlugin();
    if (nativeNotif) {
      try {
        const perm = await nativeNotif.requestPermissions();
        if (perm && perm.display !== 'granted') {
          toast('기기 설정에서 알림 권한을 허용해 주세요.', 'warn');
          return;
        }
        await nativeNotif.schedule({
          notifications: [{
            id: REMINDER_NOTIF_ID + 1,
            title: '코토노하 테스트 알림 🔔',
            body: bodyText,
            schedule: { at: new Date(Date.now() + 1500) }
          }]
        });
        toast('1.5초 후 기기 상단에 테스트 알림이 도착합니다!', 'info');
        return;
      } catch (err) {
        toast('네이티브 테스트 알림 실패: ' + (err.message || err), 'warn');
        return;
      }
    }
    if ('Notification' in window) {
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm === 'granted') {
        new Notification('코토노하 테스트 알림 🔔', { body: bodyText });
        toast('브라우저 테스트 알림을 발송했습니다 ✅', 'info');
        return;
      }
    }
    toast('알림 테스트: ' + bodyText, 'info');
  }

  function startWebReminderTicker() {
    if (reminderTimerId) clearInterval(reminderTimerId);
    reminderTimerId = setInterval(() => {
      if (!prefs.reminderEnabled || getNativeLocalNotifPlugin()) return;
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const todayKey = now.toISOString().slice(0, 10);
      if (`${hh}:${mm}` === prefs.reminderTime && prefs.lastWebReminderDate !== todayKey) {
        prefs.lastWebReminderDate = todayKey;
        savePrefs();
        const bodyText = (prefs.reminderMessage || DEFAULT_PREFS.reminderMessage).trim();
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('코토노하 매일 12분 일본어', { body: bodyText });
        }
        toast('🔔 ' + bodyText, 'info');
      }
    }, 30000);
  }

  // ---------- Runtime Mode, Storage Usage & Cache-Only Clear ----------
  function detectRuntimeModeLabel() {
    const b = bridge();
    const isCap = !!(b && b.isNativeCapacitor && b.isNativeCapacitor());
    const host = (window.location && window.location.hostname) || '';
    if (isCap) {
      return (host === 'localhost' || host === '127.0.0.1')
        ? 'Android/iOS 독립 로컬 APK (오프라인 완결형)'
        : `Android/iOS OTA APK (${host})`;
    }
    if (host === 'localhost' || host === '127.0.0.1') return 'PC 웹 브라우저 (로컬 테스트 서버)';
    if (window.location.protocol === 'file:') return '로컬 파일 직접 실행 (file:// 제한 모드)';
    return `웹 PWA (${host || '온라인'})`;
  }

  async function refreshAppInfoUI() {
    const modeEl = document.getElementById('info-runtime-mode');
    const verEl = document.getElementById('info-app-version');
    const storageEl = document.getElementById('info-storage-usage');
    const cacheEl = document.getElementById('info-cache-entries');
    if (verEl) verEl.textContent = APP_VERSION;
    if (modeEl) modeEl.textContent = detectRuntimeModeLabel();

    let totalBytes = 0;
    try {
      for (const k of ['kotonoha_app_ko_v1', VAULT_STORAGE_KEY, PREFS_STORAGE_KEY]) {
        const v = localStorage.getItem(k);
        if (v) totalBytes += new Blob([v]).size;
      }
    } catch (e) {}
    if (storageEl) storageEl.textContent = `${(totalBytes / 1024).toFixed(1)} KB (학습 기록 + 암호화 금고)`;

    if (cacheEl) {
      try {
        if ('caches' in window) {
          const names = await caches.keys();
          let count = 0;
          for (const n of names) {
            const c = await caches.open(n);
            const reqs = await c.keys();
            count += reqs.length;
          }
          cacheEl.textContent = `${names.length}개 캐시 / ${count}개 리소스`;
        } else {
          cacheEl.textContent = '캐시 미사용 환경';
        }
      } catch (e) {
        cacheEl.textContent = '조회 불가';
      }
    }
  }

  async function clearCacheOnlyKeepData() {
    let cleared = 0;
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        cleared = keys.length;
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => {})));
      }
    } catch (e) {}
    await refreshAppInfoUI();
    toast(`화면 캐시(${cleared}개)만 깨끗이 비웠습니다. 학습 기록과 암호화 API 키는 안전하게 유지됩니다!`, 'info');
  }

  // ---------- Speaking View Bar UI ----------
  function setLiveStatusUI(mode, text) {
    const el = document.getElementById('ai-live-status');
    const dot = document.getElementById('ai-live-dot');
    if (el) el.textContent = text;
    if (dot) {
      const color =
        mode === 'listening' ? 'bg-emerald-500 animate-pulse' :
        mode === 'speaking' ? 'bg-brand-600 animate-pulse' :
        mode === 'connecting' ? 'bg-amber-400 animate-pulse' :
        'bg-slate-300';
      dot.className = 'w-2.5 h-2.5 rounded-full shrink-0 ' + color;
    }
  }

  function updateLiveButtonsUI(active) {
    const toggleBtn = document.getElementById('btn-ai-live-toggle');
    const muteBtn = document.getElementById('btn-ai-live-mute');
    if (toggleBtn) {
      toggleBtn.textContent = active ? '⏹ 실시간 대화 종료' : '🎙️ 실시간 음성 대화 시작';
      toggleBtn.className = active
        ? 'px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition'
        : 'px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition';
    }
    if (muteBtn) {
      muteBtn.classList.toggle('hidden', !active);
      syncMuteButtonUI();
    }
  }

  function renderLiveSubtitle(userTxt, aiTxt) {
    const box = document.getElementById('ai-live-subtitle');
    if (!box) return;
    if (!userTxt && !aiTxt) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML =
      (userTxt ? `<div class="text-xs text-slate-600"><span class="font-bold text-brand-700">나 (실시간):</span> ${escapeHtml(userTxt)}</div>` : '') +
      (aiTxt ? `<div class="text-xs text-slate-800 mt-1"><span class="font-bold text-indigo-700">AI (실시간):</span> ${escapeHtml(aiTxt)}</div>` : '');
  }

  function renderSpeakingBar() {
    const bar = document.getElementById('ai-engine-bar');
    if (!bar) return;

    const b = bridge();
    const st = b && b.getState ? b.getState() : null;
    const hasPw = !!(st && st.user && st.user.hasPassword);
    const selectEl = document.getElementById('sp-ai-profile-select');
    const toggleBtn = document.getElementById('btn-ai-live-toggle');
    const lockHint = document.getElementById('sp-ai-lock-hint');
    const pinBadge = document.getElementById('sp-ai-pin-badge');
    const swapBtn = document.getElementById('btn-sp-swap-backup');

    if (!hasPw || !vaultUnlocked) {
      if (selectEl) {
        selectEl.innerHTML = '<option value="builtin">내장 기본 모드 (오프라인 · 무료)</option>';
        selectEl.disabled = true;
      }
      if (toggleBtn) toggleBtn.classList.add('hidden');
      if (pinBadge) pinBadge.classList.add('hidden');
      if (swapBtn) swapBtn.classList.add('hidden');
      if (lockHint) {
        lockHint.classList.remove('hidden');
        lockHint.innerHTML = !hasWebCrypto()
          ? '⚠️ HTTPS 또는 <code>http://localhost</code> 주소에서만 AES-GCM 암호화 금고를 열 수 있습니다.'
          : '🔒 <strong>엄격 보안 모드:</strong> 외부 AI(Gemini Live·커스텀 API)를 쓰려면 <button type="button" id="btn-sp-goto-sec" class="underline font-bold text-brand-700">⚙️ 설정 → 보안 및 비밀번호에서 비밀번호를 먼저 설정</button>하세요.';
        const gotoBtn = document.getElementById('btn-sp-goto-sec');
        if (gotoBtn) gotoBtn.addEventListener('click', () => openSettingsPage('security'));
      }
      if (!isLiveActive) setLiveStatusUI('idle', '내장 기본 모드 (오프라인 규칙 회화)');
      return;
    }

    if (lockHint) lockHint.classList.add('hidden');
    if (selectEl) {
      selectEl.disabled = false;
      const opts = ['<option value="builtin">내장 기본 모드 (오프라인 · 무료)</option>'];
      for (const p of (vaultData.profiles || [])) {
        const readyTag = isProfileReady(p) ? '' : ' [키 미입력]';
        const pinTag = vaultData.pinnedProfileId === p.id ? '📌 ' : '';
        const kind = p.type === 'gemini-live' ? 'Live 음성' : '턴제 API';
        opts.push(`<option value="${escapeHtml(p.id)}">${pinTag}${escapeHtml(p.name)} (${kind})${readyTag}</option>`);
      }
      if (isBackupReady()) {
        const bk = vaultData.backupApi;
        opts.push(`<option value="${BACKUP_PROFILE_ID}">🛡️ 예비 API: ${escapeHtml(bk.name)} (${escapeHtml(bk.model)})</option>`);
      }
      selectEl.innerHTML = opts.join('');
      selectEl.value = vaultData.activeProfileId || 'builtin';
    }

    if (pinBadge) {
      const isPinnedActive = !!(vaultData.pinnedProfileId && vaultData.pinnedProfileId === vaultData.activeProfileId);
      pinBadge.classList.toggle('hidden', !isPinnedActive);
    }

    if (swapBtn) {
      const canSwap = isBackupReady() && vaultData.activeProfileId !== BACKUP_PROFILE_ID;
      swapBtn.classList.toggle('hidden', !canSwap);
    }

    const active = getActiveProfile();
    if (active && active.type === 'gemini-live') {
      if (toggleBtn) toggleBtn.classList.remove('hidden');
      if (!isLiveActive) {
        const bkHint = (vaultData.backupApi && vaultData.backupApi.enabled && isBackupReady()) ? ' · 🛡️ 예비 API 자동 전환 대기' : '';
        setLiveStatusUI('idle', isProfileReady(active)
          ? `Gemini Live 준비됨 · ${active.model} (${active.voiceName || 'Kore'})${bkHint}`
          : '⚠️ 오른쪽 [⚙️ API 설정] 버튼을 눌러 Gemini API 키를 입력해 주세요');
      }
    } else if (active && active.type === 'openai-compat') {
      if (toggleBtn) toggleBtn.classList.add('hidden');
      const bkTag = active.id === BACKUP_PROFILE_ID ? '🛡️ 예비 API 활성 · ' : '턴제 커스텀 AI 활성 · ';
      setLiveStatusUI('idle', isProfileReady(active)
        ? `${bkTag}${active.name} (${active.model})`
        : '⚠️ 오른쪽 [⚙️ API 설정] 버튼을 눌러 API 키/URL을 입력해 주세요');
    } else {
      if (toggleBtn) toggleBtn.classList.add('hidden');
      setLiveStatusUI('idle', '내장 기본 모드 (오프라인 규칙 회화)');
    }
  }

  // ---------- Full-Screen Settings Hub & Sub-Page Routing ----------
  function openSettingsPage(pageId) {
    const b = bridge();
    if (!b) return;
    const target = SETTINGS_PAGES[pageId] ? pageId : 'hub';
    currentSettingsPage = target;
    explicitSubpageTarget = target;
    const st = b.getState();
    if (st.activeNav !== 'security') {
      b.switchNav('security');
    } else {
      explicitSubpageTarget = null;
      renderSettingsRouter(true);
    }
  }

  function closeSettingsToPrevious() {
    const b = bridge();
    if (!b) return;
    const prev = b.getLastNonSettingsNav ? b.getLastNonSettingsNav() : 'home';
    currentSettingsPage = 'hub';
    b.switchNav(prev === 'security' ? 'home' : prev);
  }

  function renderSettingsRouter(scrollToTop) {
    if (!settingsHubReady) return;
    const hubEl = document.getElementById('settings-hub-home');
    const subHeaderEl = document.getElementById('settings-sub-header');
    const subTitleEl = document.getElementById('settings-sub-title');
    const pageTitleEl = document.getElementById('header-page-title');

    const isHub = currentSettingsPage === 'hub';
    if (hubEl) hubEl.classList.toggle('hidden', !isHub);
    if (subHeaderEl) subHeaderEl.classList.toggle('hidden', isHub);

    document.querySelectorAll('.settings-subpage').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.spage !== currentSettingsPage);
    });

    const meta = SETTINGS_PAGES[currentSettingsPage] || SETTINGS_PAGES.hub;
    if (subTitleEl) subTitleEl.textContent = meta.title;
    if (pageTitleEl) {
      const b = bridge();
      if (b && b.getState && b.getState().activeNav === 'security') {
        pageTitleEl.textContent = isHub ? '⚙️ 설정' : `⚙️ 설정 › ${meta.title}`;
      }
    }

    renderHubSummaryBadges();
    if (currentSettingsPage === 'ai') {
      renderVaultCard();
      syncLiveStyleFormUI();
    } else if (currentSettingsPage === 'display') {
      syncDisplayFormUI();
      if (window.KotonohaScenes && window.KotonohaScenes.renderSettingsManagerGrid) {
        window.KotonohaScenes.renderSettingsManagerGrid();
      }
    } else if (currentSettingsPage === 'learning') {
      syncLearningDefaultsFormUI();
    } else if (currentSettingsPage === 'reminder') {
      syncReminderFormUI();
    } else if (currentSettingsPage === 'data') {
      refreshAppInfoUI();
    } else if (currentSettingsPage === 'security' || currentSettingsPage === 'voice') {
      const b = bridge();
      if (b && b.renderSecurity) b.renderSecurity();
    }

    const b = bridge();
    if (b && b.refreshIcons) b.refreshIcons();
    if (scrollToTop) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderHubSummaryBadges() {
    const b = bridge();
    const st = b && b.getState ? b.getState() : null;
    const hasPw = !!(st && st.user && st.user.hasPassword);

    const setBadge = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls) el.className = cls;
    };

    if (!hasPw || !vaultUnlocked) {
      setBadge('hub-badge-ai', '🔒 비밀번호 필요', 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700');
    } else {
      const act = getActiveProfile();
      const pinPrefix = (act && vaultData.pinnedProfileId === act.id) ? '📌 ' : '🔓 ';
      setBadge('hub-badge-ai', act ? `${pinPrefix}${act.name}` : '🔓 내장 기본', 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700');
    }

    setBadge('hub-badge-security',
      hasPw ? 'PBKDF2 보호 중' : '게스트 (미잠금)',
      hasPw
        ? 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-brand-50 text-brand-700'
        : 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-rose-50 text-rose-700'
    );

    const fontLabel = prefs.jpFontSize === 'xl' ? '아주 크게' : prefs.jpFontSize === 'lg' ? '크게' : '보통';
    setBadge('hub-badge-display', `${prefs.theme === 'dark' ? '다크' : '라이트'} · ${fontLabel}`, 'text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600 border border-surface-border');

    if (st) {
      setBadge('hub-badge-learning', `목표 ${st.dailyTarget || 6}단어 · ${st.speakingRegister === 'casual' ? '반말' : '존댓말'}`, 'text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600 border border-surface-border');
    }

    setBadge('hub-badge-reminder',
      prefs.reminderEnabled ? `매일 ${prefs.reminderTime}` : '꺼짐',
      prefs.reminderEnabled
        ? 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700'
        : 'text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-500 border border-surface-border'
    );

    if (st) {
      const veMap = { auto: 'Azure 내장', 'online-free': '온라인 MP3', browser: '브라우저 음성', openai: 'OpenAI 음성' };
      setBadge('hub-badge-voice', veMap[st.voiceEngine] || '자동', 'text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600 border border-surface-border');
    }

    setBadge('hub-badge-data', 'v2.4.2 · 백업/복원', 'text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600 border border-surface-border');
  }

  // ---------- Vault Card & Backup Failover Card Rendering ----------
  function renderVaultCard() {
    const card = document.getElementById('ai-vault-card');
    if (!card) return;

    const b = bridge();
    const st = b && b.getState ? b.getState() : null;
    const hasPw = !!(st && st.user && st.user.hasPassword);
    const lockedBanner = document.getElementById('vault-locked-banner');
    const vaultBody = document.getElementById('vault-unlocked-body');
    const backupCard = document.getElementById('ai-backup-card');
    const statusPill = document.getElementById('vault-status-pill');

    if (!hasWebCrypto()) {
      statusPill.textContent = '암호화 환경 필요';
      statusPill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700';
      lockedBanner.classList.remove('hidden');
      lockedBanner.innerHTML = `
        <div class="text-xs font-bold text-rose-700">⚠️ Web Crypto API(AES-GCM-256)를 사용할 수 없는 주소입니다</div>
        <p class="text-xs text-slate-600 mt-1">
          엄격 보안 모드는 평문 API 키 저장을 허용하지 않습니다. 반드시 <code>https://</code>(GitHub Pages / APK) 또는 <code>http://localhost:8080</code> 주소로 열어 주세요.
        </p>
      `;
      vaultBody.classList.add('hidden');
      if (backupCard) backupCard.classList.add('hidden');
      return;
    }

    if (!hasPw || !vaultUnlocked) {
      statusPill.textContent = '🔒 잠김 (비밀번호 필요)';
      statusPill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700';
      lockedBanner.classList.remove('hidden');
      lockedBanner.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div class="text-xs font-bold text-amber-800">🔒 엄격 보안 모드: 앱 비밀번호 설정 후 API 키를 입력할 수 있습니다</div>
            <p class="text-xs text-slate-600 mt-0.5">
              등록하는 모든 주 API 키와 예비 API 키는 앱 비밀번호 기반 <strong>PBKDF2 + AES-GCM-256</strong>으로 암호화되어 기기에만 저장되며 백업 JSON에서 자동 제외됩니다.
            </p>
          </div>
          <button type="button" id="btn-vault-goto-pw" class="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shrink-0 transition">
            보안 및 비밀번호로 이동 →
          </button>
        </div>
      `;
      vaultBody.classList.add('hidden');
      if (backupCard) backupCard.classList.add('hidden');
      const gotoBtn = document.getElementById('btn-vault-goto-pw');
      if (gotoBtn) {
        gotoBtn.addEventListener('click', () => {
          openSettingsPage('security');
          setTimeout(() => {
            const inp = document.getElementById('sec-new-pw');
            if (inp) inp.focus();
          }, 80);
        });
      }
      return;
    }

    statusPill.textContent = vaultData.editLocked ? '🔒 편집 잠금 보호 중' : '🔓 AES-GCM-256 암호화 보호 중';
    statusPill.className = vaultData.editLocked
      ? 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-900 text-white'
      : 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700';
    lockedBanner.classList.add('hidden');
    vaultBody.classList.remove('hidden');
    if (backupCard) backupCard.classList.remove('hidden');

    syncEditLockUI();
    renderProfileListUI();
    syncBackupFormUI();
  }

  function syncEditLockUI() {
    const locked = !!vaultData.editLocked;
    const toggleBtn = document.getElementById('btn-vault-edit-lock');
    const formWrap = document.getElementById('vault-editor-form-wrap');
    const bkSaveBtn = document.getElementById('btn-bk-save');
    if (toggleBtn) {
      toggleBtn.textContent = locked ? '🔓 키 편집 잠금 해제' : '🔒 키 편집 잠금 (오조작 방지)';
      toggleBtn.className = locked
        ? 'px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold transition'
        : 'px-3 py-1.5 rounded-xl bg-white border border-slate-200 hover:border-brand-400 text-slate-700 text-[11px] font-semibold transition';
    }
    if (formWrap) {
      formWrap.classList.toggle('opacity-60', locked);
      formWrap.classList.toggle('pointer-events-none', locked);
    }
    if (bkSaveBtn) {
      bkSaveBtn.disabled = locked;
      bkSaveBtn.classList.toggle('opacity-50', locked);
    }
  }

  function renderProfileListUI() {
    const listEl = document.getElementById('vault-profile-list');
    if (!listEl) return;

    const activeId = vaultData.activeProfileId || 'builtin';
    const pinnedId = vaultData.pinnedProfileId || '';
    const locked = !!vaultData.editLocked;
    const items = [];

    items.push(`
      <div class="p-3 rounded-2xl border ${activeId === 'builtin' ? 'border-brand-500 bg-brand-50/60' : 'border-slate-200 bg-surface-bg'} flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="text-xs font-bold text-slate-900">내장 기본 모드 (오프라인 · 무료)</div>
          <div class="text-[11px] text-slate-500">API 키 없이 코토노하 기본 시나리오 규칙으로 대화합니다.</div>
        </div>
        <button type="button" data-ai-use="builtin" class="px-3 py-1.5 rounded-xl text-xs font-semibold ${activeId === 'builtin' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'}">
          ${activeId === 'builtin' ? '✓ 사용 중' : '선택'}
        </button>
      </div>
    `);

    for (const p of (vaultData.profiles || [])) {
      const isAct = activeId === p.id;
      const isPinned = pinnedId === p.id;
      const ready = isProfileReady(p);
      const badge = p.type === 'gemini-live'
        ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">Gemini Live 실시간 음성</span>'
        : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">OpenAI 호환 턴제</span>';
      const keyState = ready
        ? '<span class="text-[10px] font-semibold text-emerald-700">🔑 암호화 키 저장됨</span>'
        : '<span class="text-[10px] font-semibold text-amber-600">⚠️ 키 입력 필요</span>';
      const pinChip = isPinned
        ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">📌 기본 고정됨</span>'
        : '';

      items.push(`
        <div class="p-3 rounded-2xl border ${isAct ? 'border-brand-500 bg-brand-50/60' : 'border-slate-200 bg-white'} space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="space-y-0.5 min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-xs font-bold text-slate-900">${escapeHtml(p.name)}</span>
                ${badge}
                ${pinChip}
                ${keyState}
              </div>
              <div class="text-[11px] text-slate-500 truncate">
                모델: <code>${escapeHtml(p.model || '-')}</code>
                ${p.type === 'gemini-live' ? ` · 목소리: ${escapeHtml(p.voiceName || 'Kore')}` : ` · 주소: ${escapeHtml(p.baseUrl || '-')}`}
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-1.5 shrink-0">
              <button type="button" data-ai-use="${escapeHtml(p.id)}" class="px-3 py-1.5 rounded-xl text-xs font-semibold ${isAct ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-800 hover:bg-brand-100'}">
                ${isAct ? '✓ 사용 중' : '선택'}
              </button>
              <button type="button" data-ai-pin="${escapeHtml(p.id)}" class="px-2.5 py-1.5 rounded-xl text-xs font-semibold border ${isPinned ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}">
                ${isPinned ? '📌 고정 해제' : '📌 기본 고정'}
              </button>
              <button type="button" data-ai-test="${escapeHtml(p.id)}" class="px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100">연결 테스트</button>
              <button type="button" data-ai-edit="${escapeHtml(p.id)}" ${locked ? 'disabled' : ''} class="px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-slate-200 text-slate-700 ${locked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-50'}">편집</button>
              <button type="button" data-ai-del="${escapeHtml(p.id)}" ${locked ? 'disabled' : ''} class="px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-rose-200 text-rose-700 ${locked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-rose-50'}">삭제</button>
            </div>
          </div>
        </div>
      `);
    }

    listEl.innerHTML = items.join('');
  }

  function syncBackupFormUI() {
    const bk = vaultData.backupApi || createDefaultBackupApi();
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const enEl = document.getElementById('bk-enabled');
    const stPill = document.getElementById('bk-status-pill');
    if (enEl) enEl.checked = !!bk.enabled;
    setV('bk-name', bk.name || '예비 API (자동 전환)');
    setV('bk-base-url', bk.baseUrl || '');
    setV('bk-model', bk.model || '');
    setV('bk-api-key', bk.apiKey || '');
    if (stPill) {
      if (isBackupReady() && bk.enabled) {
        stPill.textContent = '🛡️ 자동 전환 대기 중';
        stPill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700';
      } else if (isBackupReady()) {
        stPill.textContent = '저장됨 (자동 전환 꺼짐)';
        stPill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600';
      } else {
        stPill.textContent = '미등록 (선택 사항)';
        stPill.className = 'text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700';
      }
    }
  }

  function loadProfileIntoForm(profile) {
    const typeEl = document.getElementById('vf-type');
    const nameEl = document.getElementById('vf-name');
    const authEl = document.getElementById('vf-live-auth');
    const tokenEl = document.getElementById('vf-token-url');
    const baseEl = document.getElementById('vf-base-url');
    const keyEl = document.getElementById('vf-api-key');
    const modelEl = document.getElementById('vf-model');
    const voiceEl = document.getElementById('vf-voice');
    const langEl = document.getElementById('vf-lang-hint');
    const titleEl = document.getElementById('vf-form-title');
    if (!typeEl) return;

    if (!profile) {
      editingProfileId = null;
      titleEl.textContent = '+ 새 API 프로필 추가';
      typeEl.value = 'gemini-live';
      nameEl.value = '';
      authEl.value = 'apiKey';
      tokenEl.value = '';
      baseEl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
      keyEl.value = '';
      modelEl.value = 'gemini-3.1-flash-live-preview';
      voiceEl.value = 'Kore';
      langEl.checked = false;
    } else {
      editingProfileId = profile.id;
      titleEl.textContent = `프로필 편집: ${profile.name}`;
      typeEl.value = profile.type || 'gemini-live';
      nameEl.value = profile.name || '';
      authEl.value = profile.authMode || 'apiKey';
      tokenEl.value = profile.tokenUrl || '';
      baseEl.value = profile.baseUrl || '';
      keyEl.value = profile.apiKey || '';
      modelEl.value = profile.model || '';
      voiceEl.value = profile.voiceName || 'Kore';
      langEl.checked = !!profile.sendLangHint;
    }
    syncFormFieldVisibility();
  }

  function syncFormFieldVisibility() {
    const typeEl = document.getElementById('vf-type');
    if (!typeEl) return;
    const isLive = typeEl.value === 'gemini-live';
    const isEph = isLive && document.getElementById('vf-live-auth').value === 'ephemeral';
    document.getElementById('vf-live-fields').classList.toggle('hidden', !isLive);
    document.getElementById('vf-compat-fields').classList.toggle('hidden', isLive);
    document.getElementById('vf-apikey-row').classList.toggle('hidden', isEph);
    document.getElementById('vf-tokenurl-row').classList.toggle('hidden', !isEph);
  }

  function readFormAsProfile() {
    const type = document.getElementById('vf-type').value;
    const baseName = document.getElementById('vf-name').value.trim();
    return {
      id: editingProfileId || ('prof_' + Date.now()),
      name: baseName || (type === 'gemini-live' ? 'Gemini Live' : '커스텀 AI'),
      type,
      authMode: document.getElementById('vf-live-auth').value,
      tokenUrl: document.getElementById('vf-token-url').value.trim(),
      baseUrl: document.getElementById('vf-base-url').value.trim(),
      apiKey: document.getElementById('vf-api-key').value.trim(),
      model: document.getElementById('vf-model').value.trim(),
      voiceName: document.getElementById('vf-voice').value || 'Kore',
      sendLangHint: !!document.getElementById('vf-lang-hint').checked
    };
  }

  function readBackupForm() {
    return {
      enabled: !!document.getElementById('bk-enabled').checked,
      name: document.getElementById('bk-name').value.trim() || '예비 API (자동 전환)',
      type: 'openai-compat',
      baseUrl: document.getElementById('bk-base-url').value.trim(),
      model: document.getElementById('bk-model').value.trim(),
      apiKey: document.getElementById('bk-api-key').value.trim()
    };
  }

  async function runProbeWithUI(profile, resultBoxId) {
    const box = document.getElementById(resultBoxId || 'vf-test-result');
    if (box) {
      box.className = 'text-xs rounded-xl px-3 py-2 border border-sky-200 bg-sky-50 text-sky-800 block';
      box.textContent = '연결 테스트 중…';
    }
    try {
      const okMsg = await testProfileConnection(profile);
      if (box) {
        box.className = 'text-xs rounded-xl px-3 py-2 border border-emerald-200 bg-emerald-50 text-emerald-800 font-semibold block';
        box.textContent = okMsg;
      }
      toast(okMsg, 'info');
    } catch (err) {
      const errMsg = '연결 실패: ' + (err.message || '네트워크/CORS/API 키 오류');
      if (box) {
        box.className = 'text-xs rounded-xl px-3 py-2 border border-rose-200 bg-rose-50 text-rose-700 block';
        box.textContent = errMsg;
      }
      toast(errMsg, 'error');
    }
  }

  // ---------- Form Sync Helpers ----------
  function syncDisplayFormUI() {
    const tEl = document.getElementById('pref-theme-select');
    const fEl = document.getElementById('pref-jp-font-select');
    if (tEl) tEl.value = prefs.theme || 'light';
    if (fEl) fEl.value = prefs.jpFontSize || 'normal';
  }

  function syncLiveStyleFormUI() {
    const lEl = document.getElementById('pref-live-length');
    const sEl = document.getElementById('pref-live-speed');
    const mEl = document.getElementById('pref-live-muted');
    const bEl = document.getElementById('pref-audio-bridge');
    if (lEl) lEl.value = prefs.liveReplyLength || 'normal';
    if (sEl) sEl.value = prefs.liveSpeedHint || 'normal';
    if (mEl) mEl.checked = !!prefs.liveStartMuted;
    if (bEl) bEl.checked = prefs.useAudioElementBridge !== false;
  }

  function syncLearningDefaultsFormUI() {
    const b = bridge();
    const st = b && b.getState ? b.getState() : null;
    if (!st) return;
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setC = (id, c) => { const el = document.getElementById(id); if (el) el.checked = !!c; };
    setV('ld-nickname', st.user.nickname || '일본어 학습자');
    setV('ld-daily-target', String(st.dailyTarget || 6));
    setV('ld-register', st.speakingRegister || 'polite');
    setV('ld-listen-speed', String(st.listenSpeed || 1.0));
    setC('ld-vocab-furi', st.vocabShowFurigana);
    setC('ld-listen-furi', st.listenShowFurigana);
    setC('ld-listen-ko', st.listenShowKo);
    setC('ld-auto-tts', st.autoTts);
  }

  function syncReminderFormUI() {
    const enEl = document.getElementById('rem-enabled');
    const timeEl = document.getElementById('rem-time');
    const msgEl = document.getElementById('rem-message');
    const envEl = document.getElementById('rem-env-note');
    if (enEl) enEl.checked = !!prefs.reminderEnabled;
    if (timeEl) timeEl.value = prefs.reminderTime || '21:00';
    if (msgEl) msgEl.value = prefs.reminderMessage || DEFAULT_PREFS.reminderMessage;
    if (envEl) {
      envEl.textContent = getNativeLocalNotifPlugin()
        ? '실행 환경: Android/iOS 네이티브 로컬 알림 (앱이 꺼져 있어도 매일 예약 발송)'
        : '실행 환경: 웹 브라우저 알림 (PC 테스트 시 탭 열림 상태에서 동작 · APK 빌드 시 네이티브 자동 전환)';
    }
  }

  function renderAllAIViews() {
    renderSpeakingBar();
    renderVaultCard();
    renderHubSummaryBadges();
    const b = bridge();
    if (settingsHubReady && b && b.getState && b.getState().activeNav === 'security') {
      renderSettingsRouter(false);
    }
  }

  // ---------- Build Speaking Control Bar (With Pin badge, Backup Swap & Earphone/Mic Drawer) ----------
  function injectSpeakingBar() {
    const chatBox = document.getElementById('chat-messages');
    if (!chatBox || document.getElementById('ai-engine-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'ai-engine-bar';
    bar.className = 'bg-brand-50/70 rounded-2xl border border-brand-200 p-3.5 space-y-2.5 shadow-xs';
    bar.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0 flex-1">
          <span id="ai-live-dot" class="w-2.5 h-2.5 rounded-full bg-slate-300 shrink-0"></span>
          <select id="sp-ai-profile-select" aria-label="회화 AI 엔진 선택" class="max-w-full px-2.5 py-1.5 rounded-xl bg-white border border-brand-200 text-xs font-bold text-slate-800">
            <option value="builtin">내장 기본 모드 (오프라인 · 무료)</option>
          </select>
          <span id="sp-ai-pin-badge" class="hidden text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 shrink-0">📌 고정</span>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 shrink-0">
          <button type="button" id="btn-sp-swap-backup" title="예비 API로 즉시 전환" class="hidden px-2.5 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100 text-xs font-semibold transition">🛡️ 예비 전환</button>
          <button type="button" id="btn-sp-audio-drawer" title="이어폰 출력 및 마이크 장치 선택" class="px-2.5 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 hover:text-brand-700 hover:border-brand-300 text-xs font-semibold transition">🎧 이어폰</button>
          <button type="button" id="btn-sp-open-ai-settings" class="px-2.5 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 hover:text-brand-700 hover:border-brand-300 text-xs font-semibold transition">⚙️ API</button>
          <button type="button" id="btn-ai-live-mute" class="hidden px-3 py-2 rounded-xl bg-white border border-brand-200 text-brand-700 text-xs font-semibold transition">🎙️ 마이크 켜짐</button>
          <button type="button" id="btn-ai-live-toggle" class="hidden px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition">🎙️ 실시간 음성 대화 시작</button>
        </div>
      </div>

      <!-- Earphone / Output & Mic Selector Drawer -->
      <div id="sp-audio-drawer" class="hidden bg-white rounded-xl border border-brand-200 p-3 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-800">🎧 이어폰 · 스피커 · 마이크 장치 선택</span>
          <button type="button" id="btn-sp-refresh-devices" class="text-[11px] font-semibold text-brand-700 hover:underline">🔄 장치 새로고침</button>
        </div>
        <div class="grid sm:grid-cols-2 gap-2">
          <div>
            <label for="sp-audio-output-select" class="block text-[11px] font-semibold text-slate-600 mb-1">음성 출력 (이어폰/헤드셋 선택)</label>
            <select id="sp-audio-output-select" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-surface-bg"></select>
          </div>
          <div>
            <label for="sp-audio-input-select" class="block text-[11px] font-semibold text-slate-600 mb-1">입력 마이크 (블루투스 끊김 시 내장 마이크 권장)</label>
            <select id="sp-audio-input-select" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-surface-bg"></select>
          </div>
        </div>
        <p id="sp-audio-device-note" class="text-[11px] text-slate-500">이어폰을 연결한 뒤 [🔄 장치 새로고침]을 눌러 선택하세요.</p>
      </div>

      <div id="ai-live-status" class="text-[11px] font-semibold text-slate-600">내장 기본 모드 (오프라인 규칙 회화)</div>
      <div id="sp-ai-lock-hint" class="hidden text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2"></div>
      <div id="ai-live-subtitle" class="hidden bg-white/95 rounded-xl border border-brand-100 px-3 py-2 font-jp"></div>
    `;
    chatBox.parentNode.insertBefore(bar, chatBox);

    document.getElementById('btn-sp-open-ai-settings').addEventListener('click', () => openSettingsPage('ai'));
    document.getElementById('btn-sp-swap-backup').addEventListener('click', () => {
      if (!isBackupReady()) return;
      stopLiveSession(true);
      vaultData.activeProfileId = BACKUP_PROFILE_ID;
      renderAllAIViews();
      toast(`🛡️ 예비 API「${vaultData.backupApi.name}」로 즉시 전환했습니다!`, 'info');
    });
    document.getElementById('btn-sp-audio-drawer').addEventListener('click', () => {
      const dr = document.getElementById('sp-audio-drawer');
      if (!dr) return;
      const willOpen = dr.classList.contains('hidden');
      dr.classList.toggle('hidden');
      if (willOpen) refreshAudioDeviceSelectors(true);
    });
    document.getElementById('btn-sp-refresh-devices').addEventListener('click', () => {
      refreshAudioDeviceSelectors(true);
      toast('연결된 이어폰·마이크 목록을 새로고침했습니다', 'info');
    });
    document.getElementById('sp-audio-output-select').addEventListener('change', async (e) => {
      prefs.audioOutputId = e.target.value || '';
      savePrefs();
      await applySinkToPlayback(prefs.audioOutputId);
      toast('음성 출력 장치를 변경했습니다 🎧', 'info');
    });
    document.getElementById('sp-audio-input-select').addEventListener('change', (e) => {
      prefs.audioInputId = e.target.value || '';
      savePrefs();
      toast('입력 마이크 장치를 변경했습니다 (실시간 세션 재시작 시 반영)', 'info');
    });

    document.getElementById('sp-ai-profile-select').addEventListener('change', async (e) => {
      if (!vaultUnlocked) return;
      stopLiveSession(true);
      vaultData.activeProfileId = e.target.value;
      try { await persistVault(); } catch (err) {}
      renderAllAIViews();
      const act = getActiveProfile();
      toast(act ? `회화 엔진 전환: ${act.name}` : '내장 기본 모드로 전환했습니다', 'info');
    });
    document.getElementById('btn-ai-live-toggle').addEventListener('click', () => {
      if (isLiveActive) stopLiveSession(false);
      else startLiveSession();
    });
    document.getElementById('btn-ai-live-mute').addEventListener('click', toggleMute);
  }

  // ---------- Full-Screen Settings Hub ----------
  function setupSettingsHub() {
    const secView = document.getElementById('view-security');
    if (!secView || settingsHubReady) return;

    const cardLockStatus = document.getElementById('btn-sec-lock-now')?.closest('.bg-white');
    const cardOta = document.getElementById('btn-ota-refresh')?.closest('.bg-white');
    const cardVoice = document.getElementById('voice-engine-select')?.closest('.bg-white');
    const cardChangePw = document.getElementById('change-pw-form')?.closest('.bg-white');
    const cardAutoLock = document.getElementById('auto-lock-select')?.closest('.bg-white');
    const cardBackup = document.getElementById('btn-export-json')?.closest('.bg-white');
    const oldBottomGrid = cardAutoLock ? cardAutoLock.parentNode : null;

    const hubHome = document.createElement('div');
    hubHome.id = 'settings-hub-home';
    hubHome.className = 'space-y-4';
    hubHome.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <button type="button" id="btn-settings-back-main" class="px-3.5 py-2 rounded-xl bg-white border border-surface-border text-xs font-bold text-slate-700 hover:text-brand-700 hover:border-brand-300 inline-flex items-center gap-1.5 transition">
          <i data-lucide="arrow-left" class="w-4 h-4"></i> 이전 화면으로
        </button>
        <span class="text-xs font-semibold text-slate-400">${APP_VERSION}</span>
      </div>

      <div class="bg-white rounded-3xl border border-surface-border p-4 sm:p-5 shadow-sm space-y-2">
        <div class="px-1 pb-2">
          <h3 class="text-base font-bold text-slate-900">⚙️ 앱 설정</h3>
          <p class="text-xs text-slate-500 mt-0.5">원하는 항목을 눌러 세부 설정을 변경하세요.</p>
        </div>

        <button type="button" data-open-spage="ai" class="w-full p-3.5 rounded-2xl border border-brand-200 bg-brand-50/40 hover:bg-brand-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center shrink-0"><i data-lucide="sparkles" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">AI · API 설정</div>
              <div class="text-xs text-slate-500 truncate">주 API 고정·잠금 · 🛡️ 예비 API 자동 전환 · Gemini Live 스타일</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-ai" class="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">확인 중</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="security" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0"><i data-lucide="shield-check" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">보안 및 비밀번호</div>
              <div class="text-xs text-slate-500 truncate">앱 비밀번호 등록·변경 · 지금 잠그기 · 자동 잠금</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-security" class="text-[11px] font-bold px-2.5 py-1 rounded-full bg-brand-50 text-brand-700">확인 중</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="display" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-100 flex items-center justify-center shrink-0"><i data-lucide="moon" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">화면 · 보기 설정</div>
              <div class="text-xs text-slate-500 truncate">다크 모드 · 글자 크기 · 에피소드별 상황 그림 변경</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-display" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600">라이트</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="learning" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center justify-center shrink-0"><i data-lucide="sliders-horizontal" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">학습 기본값</div>
              <div class="text-xs text-slate-500 truncate">닉네임 · 일일 목표 · 기본 말투(존댓말/반말) · 후리가나/해석</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-learning" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600">기본값</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="reminder" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 border border-amber-100 flex items-center justify-center shrink-0"><i data-lucide="bell" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">일일 학습 알림 (리마인더)</div>
              <div class="text-xs text-slate-500 truncate">매일 지정 시각 알림 예약 · 테스트 알림</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-reminder" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-500">꺼짐</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="voice" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-sky-50 text-sky-700 border border-sky-100 flex items-center justify-center shrink-0"><i data-lucide="mic" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">음성 · 마이크 진단</div>
              <div class="text-xs text-slate-500 truncate">일본어 원어민 음성 테스트 · 마이크 3초 테스트 · 음성 엔진</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-voice" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600">Azure 내장</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>

        <button type="button" data-open-spage="data" class="w-full p-3.5 rounded-2xl border border-surface-border bg-white hover:bg-slate-50 flex items-center justify-between gap-3 text-left transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-rose-50 text-rose-700 border border-rose-100 flex items-center justify-center shrink-0"><i data-lucide="database" class="w-5 h-5"></i></div>
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">데이터 · 캐시 · 앱 정보</div>
              <div class="text-xs text-slate-500 truncate">JSON 백업/복원 · OTA 업데이트 · 캐시만 비우기 · 앱 정보</div>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span id="hub-badge-data" class="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-bg text-slate-600">v2.4.2</span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </div>
        </button>
      </div>
    `;

    const subHeader = document.createElement('div');
    subHeader.id = 'settings-sub-header';
    subHeader.className = 'hidden flex items-center justify-between gap-3';
    subHeader.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
        <button type="button" id="btn-settings-back-hub" class="px-3.5 py-2 rounded-xl bg-white border border-surface-border text-xs font-bold text-slate-700 hover:text-brand-700 hover:border-brand-300 inline-flex items-center gap-1.5 shrink-0 transition">
          <i data-lucide="arrow-left" class="w-4 h-4"></i> 설정 목록
        </button>
        <h3 id="settings-sub-title" class="text-sm sm:text-base font-bold text-slate-900 truncate">세부 설정</h3>
      </div>
      <button type="button" id="btn-settings-close-sub" class="px-3 py-2 rounded-xl border border-surface-border bg-white text-xs font-semibold text-slate-600 hover:text-slate-900 shrink-0 transition">닫기</button>
    `;

    const makeSubPage = (key) => {
      const d = document.createElement('div');
      d.className = 'settings-subpage hidden space-y-5';
      d.dataset.spage = key;
      return d;
    };

    const spAi = makeSubPage('ai');
    const spSecurity = makeSubPage('security');
    const spDisplay = makeSubPage('display');
    const spLearning = makeSubPage('learning');
    const spReminder = makeSubPage('reminder');
    const spVoice = makeSubPage('voice');
    const spData = makeSubPage('data');

    // --- Sub-Page 1: AI · API 설정 (Primary Vault + Pin/Lock + Dedicated Backup Failover API + Live Style/Earphone) ---
    spAi.innerHTML = `
      <div id="ai-vault-card" class="bg-white rounded-3xl border-2 border-brand-200 p-5 sm:p-6 shadow-sm space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h4 class="text-sm font-bold text-slate-900">1) 주 AI 회화 API 금고 (고정 · 편집 잠금 지원)</h4>
              <span id="vault-status-pill" class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700">🔒 잠김</span>
            </div>
            <p class="text-xs text-slate-500 mt-1">
              원하는 프로필에 <strong>📌 기본 고정</strong>을 켜 두면 다른 API를 추가해도 기본 엔진이 유지되며, <strong>🔒 키 편집 잠금</strong>으로 실수 수정·삭제를 막을 수 있습니다.
            </p>
          </div>
        </div>

        <div id="vault-locked-banner" class="p-4 rounded-2xl bg-amber-50 border border-amber-200"></div>

        <div id="vault-unlocked-body" class="hidden space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2 pb-1">
            <span class="text-xs font-bold text-slate-700">등록된 주 API 프로필 목록</span>
            <button type="button" id="btn-vault-edit-lock" class="px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 text-[11px] font-semibold transition">🔒 키 편집 잠금 (오조작 방지)</button>
          </div>

          <div id="vault-profile-list" class="space-y-2.5"></div>

          <div id="vault-editor-form-wrap" class="p-4 rounded-2xl bg-surface-bg border border-surface-border space-y-3 transition">
            <div class="flex items-center justify-between">
              <span id="vf-form-title" class="text-xs font-bold text-slate-900">+ 새 API 프로필 추가</span>
              <button type="button" id="btn-vf-reset" class="text-[11px] font-semibold text-slate-500 hover:text-slate-800">새 프로필 초기화</button>
            </div>

            <div class="grid sm:grid-cols-2 gap-3">
              <div>
                <label for="vf-type" class="block text-xs font-semibold text-slate-700 mb-1">API 방식</label>
                <select id="vf-type" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white font-semibold">
                  <option value="gemini-live">Google Gemini Live API (양방향 실시간 음성)</option>
                  <option value="openai-compat">OpenAI 호환 커스텀 API (턴제 · 타사 자유 교체)</option>
                </select>
              </div>
              <div>
                <label for="vf-name" class="block text-xs font-semibold text-slate-700 mb-1">프로필 이름</label>
                <input id="vf-name" type="text" placeholder="예: Gemini Live 메인 / Qwen 턴제" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
              </div>
            </div>

            <div id="vf-live-fields" class="grid sm:grid-cols-2 gap-3">
              <div>
                <label for="vf-live-auth" class="block text-xs font-semibold text-slate-700 mb-1">인증 방식</label>
                <select id="vf-live-auth" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white">
                  <option value="apiKey">Gemini API 키 직접 입력 (AES-GCM 암호화 저장)</option>
                  <option value="ephemeral">임시 토큰 서버 URL (외부 배포 권장)</option>
                </select>
              </div>
              <div>
                <label for="vf-voice" class="block text-xs font-semibold text-slate-700 mb-1">AI 목소리 (voiceName)</label>
                <select id="vf-voice" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white">
                  <option value="Kore">Kore (차분한 여성)</option>
                  <option value="Aoede">Aoede (부드러운 여성)</option>
                  <option value="Leda">Leda (밝은 여성)</option>
                  <option value="Zephyr">Zephyr (경쾌한 중성)</option>
                  <option value="Puck">Puck (친근한 남성)</option>
                  <option value="Charon">Charon (낮은 남성)</option>
                  <option value="Fenrir">Fenrir (또렷한 남성)</option>
                </select>
              </div>
              <div class="sm:col-span-2 flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap gap-1.5">
                  <button type="button" data-live-model="gemini-3.1-flash-live-preview" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:border-brand-400">3.1 Flash Live (추천)</button>
                  <button type="button" data-live-model="gemini-2.5-flash-native-audio-preview-12-2025" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:border-brand-400">2.5 Flash Native Audio</button>
                  <button type="button" data-live-model="gemini-3.8-live" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:border-brand-400">3.8 Live</button>
                </div>
                <label class="inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                  <input id="vf-lang-hint" type="checkbox" class="rounded border-slate-300" />
                  전사 <code>ja-JP</code> 힌트 강제 전달
                </label>
              </div>
            </div>

            <div id="vf-compat-fields" class="hidden space-y-2.5">
              <div>
                <div class="text-[11px] font-semibold text-slate-500 mb-1.5">빠른 공급자 템플릿 채우기:</div>
                <div class="flex flex-wrap gap-1.5">
                  <button type="button" data-tpl="gemini-openai" class="px-2.5 py-1 rounded-lg bg-white border border-brand-200 text-[11px] font-semibold text-brand-800 hover:bg-brand-50">Google Gemini</button>
                  <button type="button" data-tpl="openai" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">OpenAI</button>
                  <button type="button" data-tpl="qwen-intl" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Qwen 글로벌</button>
                  <button type="button" data-tpl="qwen-cn" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Qwen 중국</button>
                  <button type="button" data-tpl="deepseek" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">DeepSeek</button>
                  <button type="button" data-tpl="openrouter" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">OpenRouter</button>
                </div>
              </div>
              <div>
                <label for="vf-base-url" class="block text-xs font-semibold text-slate-700 mb-1">Base URL (끝에 /chat/completions 제외)</label>
                <input id="vf-base-url" type="url" placeholder="https://generativelanguage.googleapis.com/v1beta/openai" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
              </div>
            </div>

            <div class="grid sm:grid-cols-2 gap-3">
              <div>
                <label for="vf-model" class="block text-xs font-semibold text-slate-700 mb-1">모델명 (직접 수정 가능)</label>
                <input id="vf-model" type="text" placeholder="gemini-3.1-flash-live-preview" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
              </div>
              <div id="vf-apikey-row">
                <label for="vf-api-key" class="block text-xs font-semibold text-slate-700 mb-1">API 키 (AES-GCM-256 암호화 저장)</label>
                <input id="vf-api-key" type="password" placeholder="AIza... 또는 sk-..." class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
              </div>
              <div id="vf-tokenurl-row" class="hidden">
                <label for="vf-token-url" class="block text-xs font-semibold text-slate-700 mb-1">임시 토큰 발급 서버 URL</label>
                <input id="vf-token-url" type="url" placeholder="https://your-worker.workers.dev/gemini-token" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
              </div>
            </div>

            <div id="vf-test-result" class="hidden text-xs rounded-xl px-3 py-2 border"></div>

            <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button type="button" id="btn-vf-test" class="px-3.5 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 text-xs font-semibold transition">🔌 연결 테스트</button>
              <button type="button" id="btn-vf-save" class="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition">🔐 암호화 금고에 저장</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2) Dedicated Backup / Failover API Slot -->
      <div id="ai-backup-card" class="hidden bg-white rounded-3xl border-2 border-amber-200 p-5 sm:p-6 shadow-sm space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h4 class="text-sm font-bold text-slate-900">2) 🛡️ 예비 API 입력창 (주 API 오류 시 자동 전환)</h4>
              <span id="bk-status-pill" class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700">미등록</span>
            </div>
            <p class="text-xs text-slate-500 mt-1">
              주 API(예: Gemini Live)가 쿼터 초과·네트워크 오류 등으로 끊어지면 여기에 등록한 예비 API(Qwen·DeepSeek·OpenAI·Gemini 턴제 등)로 즉시 자동 전환되어 대화를 이어갑니다.
            </p>
          </div>
        </div>

        <label class="flex items-center justify-between gap-3 p-3 rounded-2xl bg-amber-50/60 border border-amber-200 cursor-pointer">
          <div>
            <div class="text-xs font-bold text-slate-900">주 API 실패 시 예비 API 자동 전환 켜기</div>
            <div class="text-[11px] text-slate-600">오류 발생 시 사용자 조작 없이 예비 API로 자동 연결합니다.</div>
          </div>
          <input id="bk-enabled" type="checkbox" class="w-4 h-4 rounded" />
        </label>

        <div>
          <div class="text-[11px] font-semibold text-slate-500 mb-1.5">예비 API 공급자 빠른 채우기:</div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" data-bk-tpl="gemini-openai" class="px-2.5 py-1 rounded-lg bg-white border border-brand-200 text-[11px] font-semibold text-brand-800 hover:bg-brand-50">Google Gemini</button>
            <button type="button" data-bk-tpl="qwen-intl" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Qwen 글로벌</button>
            <button type="button" data-bk-tpl="qwen-cn" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">Qwen 중국</button>
            <button type="button" data-bk-tpl="deepseek" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">DeepSeek</button>
            <button type="button" data-bk-tpl="openai" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">OpenAI</button>
            <button type="button" data-bk-tpl="openrouter" class="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-700 hover:bg-slate-50">OpenRouter</button>
          </div>
        </div>

        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label for="bk-name" class="block text-xs font-semibold text-slate-700 mb-1">예비 API 이름</label>
            <input id="bk-name" type="text" placeholder="예: 예비 Qwen / 예비 DeepSeek" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
          </div>
          <div>
            <label for="bk-base-url" class="block text-xs font-semibold text-slate-700 mb-1">Base URL</label>
            <input id="bk-base-url" type="url" placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
          </div>
          <div>
            <label for="bk-model" class="block text-xs font-semibold text-slate-700 mb-1">모델명</label>
            <input id="bk-model" type="text" placeholder="qwen-plus / deepseek-chat / gemini-3.5-flash-lite" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
          </div>
          <div>
            <label for="bk-api-key" class="block text-xs font-semibold text-slate-700 mb-1">예비 API 키 (AES-GCM 암호화 저장)</label>
            <input id="bk-api-key" type="password" placeholder="sk-... 또는 AIza..." class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white" />
          </div>
        </div>

        <div id="bk-test-result" class="hidden text-xs rounded-xl px-3 py-2 border"></div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="button" id="btn-bk-test" class="px-3.5 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 text-xs font-semibold transition">🔌 예비 API 연결 테스트</button>
          <button type="button" id="btn-bk-save" class="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition">🛡️ 예비 API 암호화 저장</button>
        </div>
      </div>

      <!-- 3) Gemini Live Conversation Style & Earphone Bridge Settings -->
      <div class="bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4">
        <div>
          <h4 class="text-sm font-bold text-slate-900">3) Gemini Live 대화 스타일 및 이어폰 출력 설정</h4>
          <p class="text-xs text-slate-500 mt-0.5">AI 답변 길이, 말 속도, 이어폰 출력 브리지 모드를 조절합니다.</p>
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label for="pref-live-length" class="block text-xs font-semibold text-slate-700 mb-1">AI 답변 길이</label>
            <select id="pref-live-length" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="short">짧게 · 1문장 (초급 추천)</option>
              <option value="normal">보통 · 1~2문장 (기본)</option>
              <option value="detailed">자세히 · 2~3문장 (중급 추천)</option>
            </select>
          </div>
          <div>
            <label for="pref-live-speed" class="block text-xs font-semibold text-slate-700 mb-1">AI 말 속도 힌트</label>
            <select id="pref-live-speed" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="slow">천천히 또박또박 (초급 추천)</option>
              <option value="normal">보통 속도 (기본)</option>
              <option value="natural">원어민 자연 속도</option>
            </select>
          </div>
        </div>
        <label class="flex items-center justify-between gap-3 p-3 rounded-2xl bg-surface-bg border border-surface-border cursor-pointer">
          <div>
            <div class="text-xs font-bold text-slate-800">🎧 이어폰 우선 출력 브리지 (&lt;audio&gt; 미디어 스트림 경유)</div>
            <div class="text-[11px] text-slate-500">실시간 음성이 스피커로 튀는 현상을 줄이기 위해 Web Audio를 미디어 &lt;audio&gt; 출력으로 전달합니다.</div>
          </div>
          <input id="pref-audio-bridge" type="checkbox" class="w-4 h-4 rounded border-slate-300" />
        </label>
        <label class="flex items-center justify-between gap-3 p-3 rounded-2xl bg-surface-bg border border-surface-border cursor-pointer">
          <div>
            <div class="text-xs font-bold text-slate-800">실시간 대화 시작 시 마이크 자동 음소거</div>
            <div class="text-[11px] text-slate-500">공공장소·지하철에서 실수로 주변 소음이 전송되는 것을 방지합니다.</div>
          </div>
          <input id="pref-live-muted" type="checkbox" class="w-4 h-4 rounded border-slate-300" />
        </label>
      </div>
    `;

    // --- Sub-Page 2: 보안 및 비밀번호 ---
    if (cardLockStatus) spSecurity.appendChild(cardLockStatus);
    if (cardChangePw) spSecurity.appendChild(cardChangePw);
    if (cardAutoLock) spSecurity.appendChild(cardAutoLock);

    // --- Sub-Page 3: 화면 · 보기 설정 ---
    spDisplay.innerHTML = `
      <div class="bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4">
        <div>
          <h4 class="text-sm font-bold text-slate-900">테마 및 글자 크기</h4>
          <p class="text-xs text-slate-500 mt-0.5">야간 학습용 다크 모드와 일본어 문장 글자 크기를 즉시 변경합니다.</p>
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label for="pref-theme-select" class="block text-xs font-semibold text-slate-700 mb-1">화면 테마</label>
            <select id="pref-theme-select" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="light">☀️ 라이트 모드 (기본)</option>
              <option value="dark">🌙 다크 모드 (눈 피로 감소)</option>
            </select>
          </div>
          <div>
            <label for="pref-jp-font-select" class="block text-xs font-semibold text-slate-700 mb-1">일본어 글자 크기</label>
            <select id="pref-jp-font-select" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="normal">보통 (100%)</option>
              <option value="lg">크게 (115% · 스마트폰 추천)</option>
              <option value="xl">아주 크게 (130%)</option>
            </select>
          </div>
        </div>
        <div class="p-4 rounded-2xl bg-surface-bg border border-surface-border space-y-1">
          <div class="text-[11px] font-semibold text-slate-400">미리보기</div>
          <div class="font-jp text-base font-bold text-slate-900">
            <ruby>今日<rt>きょう</rt></ruby>も<ruby>楽<rt>たの</rt></ruby>しく<ruby>日本語<rt>にほんご</rt></ruby>を<ruby>練習<rt>れんしゅう</rt></ruby>しましょう！
          </div>
          <div class="text-xs text-slate-500">오늘도 즐겁게 일본어를 연습해 봐요!</div>
        </div>
      </div>
    `;

    // --- Sub-Page 4: 학습 기본값 ---
    spLearning.innerHTML = `
      <div class="bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4">
        <div>
          <h4 class="text-sm font-bold text-slate-900">프로필 및 기본 학습 옵션</h4>
          <p class="text-xs text-slate-500 mt-0.5">홈·어휘·듣기·회화 탭의 기본 동작을 한곳에서 관리합니다.</p>
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label for="ld-nickname" class="block text-xs font-semibold text-slate-700 mb-1">학습자 닉네임</label>
            <input id="ld-nickname" type="text" maxlength="20" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
          <div>
            <label for="ld-daily-target" class="block text-xs font-semibold text-slate-700 mb-1">일일 목표 단어 수</label>
            <input id="ld-daily-target" type="number" min="3" max="30" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
          <div>
            <label for="ld-register" class="block text-xs font-semibold text-slate-700 mb-1">기본 회화 말투</label>
            <select id="ld-register" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="polite">존댓말 (丁寧語 · です/ます)</option>
              <option value="casual">친근한 반말 (タメ口)</option>
            </select>
          </div>
          <div>
            <label for="ld-listen-speed" class="block text-xs font-semibold text-slate-700 mb-1">듣기 기본 재생 속도</label>
            <select id="ld-listen-speed" class="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-surface-bg">
              <option value="0.75">0.75x (천천히)</option>
              <option value="0.85">0.85x (조금 천천히)</option>
              <option value="1">1.0x (보통)</option>
              <option value="1.15">1.15x (빠르게)</option>
            </select>
          </div>
        </div>
        <div class="grid sm:grid-cols-2 gap-2.5">
          <label class="flex items-center justify-between p-3 rounded-2xl bg-surface-bg border border-surface-border text-xs font-semibold text-slate-700 cursor-pointer">
            <span>어휘 후리가나 기본 표시</span>
            <input id="ld-vocab-furi" type="checkbox" class="w-4 h-4 rounded" />
          </label>
          <label class="flex items-center justify-between p-3 rounded-2xl bg-surface-bg border border-surface-border text-xs font-semibold text-slate-700 cursor-pointer">
            <span>듣기 후리가나 기본 표시</span>
            <input id="ld-listen-furi" type="checkbox" class="w-4 h-4 rounded" />
          </label>
          <label class="flex items-center justify-between p-3 rounded-2xl bg-surface-bg border border-surface-border text-xs font-semibold text-slate-700 cursor-pointer">
            <span>듣기 한국어 해석 기본 표시</span>
            <input id="ld-listen-ko" type="checkbox" class="w-4 h-4 rounded" />
          </label>
          <label class="flex items-center justify-between p-3 rounded-2xl bg-surface-bg border border-surface-border text-xs font-semibold text-slate-700 cursor-pointer">
            <span>회화 AI 자동 음성 읽기</span>
            <input id="ld-auto-tts" type="checkbox" class="w-4 h-4 rounded" />
          </label>
        </div>
        <div class="flex justify-end">
          <button type="button" id="btn-save-learning-defaults" class="px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition">
            학습 기본값 저장
          </button>
        </div>
      </div>
    `;

    // --- Sub-Page 5: 일일 학습 알림 ---
    spReminder.innerHTML = `
      <div class="bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4">
        <div>
          <h4 class="text-sm font-bold text-slate-900">매일 12분 일본어 학습 리마인더</h4>
          <p id="rem-env-note" class="text-xs text-slate-500 mt-0.5">알림 환경 확인 중…</p>
        </div>
        <label class="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-surface-bg border border-surface-border cursor-pointer">
          <div>
            <div class="text-xs font-bold text-slate-900">일일 학습 알림 켜기</div>
            <div class="text-[11px] text-slate-500">매일 정해진 시각에 회화 연습 알림을 보냅니다.</div>
          </div>
          <input id="rem-enabled" type="checkbox" class="w-4 h-4 rounded" />
        </label>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label for="rem-time" class="block text-xs font-semibold text-slate-700 mb-1">매일 알림 시각</label>
            <input id="rem-time" type="time" value="21:00" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
          <div>
            <label for="rem-message" class="block text-xs font-semibold text-slate-700 mb-1">알림 메시지</label>
            <input id="rem-message" type="text" maxlength="80" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm" />
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="button" id="btn-rem-test" class="px-4 py-2.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 text-xs font-semibold transition">
            🔔 지금 테스트 알림 보내기
          </button>
          <button type="button" id="btn-rem-save" class="px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold transition">
            알림 설정 저장
          </button>
        </div>
      </div>
    `;

    // --- Sub-Page 6: 음성 · 마이크 진단 ---
    if (cardVoice) {
      const voiceClarify = document.createElement('div');
      voiceClarify.className = 'p-3 rounded-2xl bg-brand-50/70 border border-brand-200 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2';
      voiceClarify.innerHTML = '<span>💡 <strong>Gemini · Qwen · DeepSeek · OpenRouter</strong> 회화용 API 키는 여기가 아니라 <strong>[AI · API 설정]</strong>에서 등록하세요. (아래 OpenAI 키는 Whisper 마이크·TTS 전용)</span><button type="button" id="btn-voice-goto-ai" class="px-3 py-1.5 rounded-xl bg-brand-600 text-white text-[11px] font-bold shrink-0">AI · API 설정으로 이동 →</button>';
      cardVoice.appendChild(voiceClarify);
      spVoice.appendChild(cardVoice);
    }

    // --- Sub-Page 7: 데이터 · 캐시 · 앱 정보 ---
    if (cardOta) spData.appendChild(cardOta);
    if (cardBackup) {
      const btnExport = cardBackup.querySelector('#btn-export-json');
      if (btnExport && btnExport.parentNode) {
        const restoreLabel = document.createElement('label');
        restoreLabel.className = 'cursor-pointer px-3.5 py-2 rounded-xl border border-sky-200 bg-sky-50 text-sky-800 text-xs font-semibold hover:bg-sky-100 transition inline-flex items-center';
        restoreLabel.innerHTML = '학습 기록 복원 (JSON 가져오기)<input id="import-backup-json-input" type="file" accept=".json" class="hidden" />';
        btnExport.parentNode.insertBefore(restoreLabel, btnExport.nextSibling);
      }
      const note = document.createElement('p');
      note.className = 'text-[11px] text-slate-500';
      note.textContent = '※ JSON 복원 시 현재 기기의 앱 비밀번호와 AES-GCM 암호화 API 키 금고는 덮어쓰지 않고 그대로 보호됩니다.';
      cardBackup.appendChild(note);
      spData.appendChild(cardBackup);
    }

    const appInfoCard = document.createElement('div');
    appInfoCard.className = 'bg-white rounded-3xl border border-surface-border p-5 sm:p-6 shadow-sm space-y-4';
    appInfoCard.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 class="text-sm font-bold text-slate-900">앱 정보 및 캐시 관리</h4>
          <p class="text-xs text-slate-500 mt-0.5">현재 빌드 모드, 저장 공간 사용량을 확인하고 학습 기록은 유지한 채 화면 캐시만 정리합니다.</p>
        </div>
        <button type="button" id="btn-clear-cache-only" class="px-4 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-semibold transition">
          🧹 캐시만 비우기 (학습 기록 유지)
        </button>
      </div>
      <div class="grid sm:grid-cols-2 gap-2.5 p-3.5 rounded-2xl bg-surface-bg border border-surface-border text-xs">
        <div>
          <div class="text-[11px] text-slate-400">앱 버전</div>
          <div id="info-app-version" class="font-bold text-slate-900 mt-0.5">${APP_VERSION}</div>
        </div>
        <div>
          <div class="text-[11px] text-slate-400">실행 · 빌드 모드</div>
          <div id="info-runtime-mode" class="font-bold text-brand-700 mt-0.5">확인 중…</div>
        </div>
        <div>
          <div class="text-[11px] text-slate-400">로컬 저장 용량</div>
          <div id="info-storage-usage" class="font-bold text-slate-800 mt-0.5">계산 중…</div>
        </div>
        <div>
          <div class="text-[11px] text-slate-400">오프라인 화면 캐시</div>
          <div id="info-cache-entries" class="font-bold text-slate-800 mt-0.5">조회 중…</div>
        </div>
      </div>
    `;
    spData.appendChild(appInfoCard);

    if (oldBottomGrid && oldBottomGrid.parentNode === secView && oldBottomGrid.children.length === 0) {
      oldBottomGrid.remove();
    }

    // Attach all elements to live DOM BEFORE mounting scene manager or binding IDs!
    secView.appendChild(hubHome);
    secView.appendChild(subHeader);
    secView.appendChild(spAi);
    secView.appendChild(spSecurity);
    secView.appendChild(spDisplay);
    secView.appendChild(spLearning);
    secView.appendChild(spReminder);
    secView.appendChild(spVoice);
    secView.appendChild(spData);

    try {
      if (window.KotonohaScenes && window.KotonohaScenes.mountSettingsManager) {
        window.KotonohaScenes.mountSettingsManager(spDisplay);
      }
    } catch (err) {
      console.error('[KotonohaAI] mountSettingsManager error:', err);
    }

    // --- Bind Hub & Sub-Page Events ---
    const gearBtn = document.getElementById('btn-open-settings');
    if (gearBtn) {
      gearBtn.addEventListener('click', () => {
        const b = bridge();
        const st = b && b.getState ? b.getState() : null;
        if (st && st.activeNav === 'security' && currentSettingsPage === 'hub') {
          closeSettingsToPrevious();
        } else {
          openSettingsPage('hub');
        }
      });
    }

    document.getElementById('btn-settings-back-main').addEventListener('click', closeSettingsToPrevious);
    document.getElementById('btn-settings-back-hub').addEventListener('click', () => openSettingsPage('hub'));
    document.getElementById('btn-settings-close-sub').addEventListener('click', closeSettingsToPrevious);
    const vGotoAi = document.getElementById('btn-voice-goto-ai');
    if (vGotoAi) vGotoAi.addEventListener('click', () => openSettingsPage('ai'));

    hubHome.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open-spage]');
      if (btn) openSettingsPage(btn.dataset.openSpage);
    });

    // Edit Lock Toggle
    document.getElementById('btn-vault-edit-lock').addEventListener('click', async () => {
      if (!vaultUnlocked) return;
      vaultData.editLocked = !vaultData.editLocked;
      try { await persistVault(); } catch (e) {}
      renderAllAIViews();
      toast(vaultData.editLocked ? '🔒 키 편집 잠금을 켰습니다 (오조작 방지)' : '🔓 키 편집 잠금을 해제했습니다', 'info');
    });

    // Primary AI Vault Form Events
    document.getElementById('vf-type').addEventListener('change', (e) => {
      const isLive = e.target.value === 'gemini-live';
      if (!editingProfileId) {
        document.getElementById('vf-model').value = isLive ? 'gemini-3.1-flash-live-preview' : GEMINI_FAST_TEXT_MODEL;
      }
      syncFormFieldVisibility();
    });
    document.getElementById('vf-live-auth').addEventListener('change', syncFormFieldVisibility);
    document.getElementById('btn-vf-reset').addEventListener('click', () => loadProfileIntoForm(null));

    spAi.addEventListener('click', async (e) => {
      const liveModelBtn = e.target.closest('[data-live-model]');
      if (liveModelBtn) { document.getElementById('vf-model').value = liveModelBtn.dataset.liveModel; return; }
      const tplBtn = e.target.closest('[data-tpl]');
      if (tplBtn) {
        const tpl = PROVIDER_TEMPLATES[tplBtn.dataset.tpl];
        if (tpl) {
          document.getElementById('vf-type').value = 'openai-compat';
          if (!document.getElementById('vf-name').value.trim()) document.getElementById('vf-name').value = tpl.label;
          document.getElementById('vf-base-url').value = tpl.baseUrl;
          document.getElementById('vf-model').value = tpl.model;
          syncFormFieldVisibility();
        }
        return;
      }
      const bkTplBtn = e.target.closest('[data-bk-tpl]');
      if (bkTplBtn) {
        const tpl = PROVIDER_TEMPLATES[bkTplBtn.dataset.bkTpl];
        if (tpl) {
          document.getElementById('bk-name').value = '예비 ' + tpl.label;
          document.getElementById('bk-base-url').value = tpl.baseUrl;
          document.getElementById('bk-model').value = tpl.model;
        }
        return;
      }
      const useBtn = e.target.closest('[data-ai-use]');
      if (useBtn) {
        stopLiveSession(true);
        vaultData.activeProfileId = useBtn.dataset.aiUse;
        await persistVault();
        renderAllAIViews();
        toast('활성 AI 회화 엔진을 변경했습니다!', 'info');
        return;
      }
      const pinBtn = e.target.closest('[data-ai-pin]');
      if (pinBtn) {
        const id = pinBtn.dataset.aiPin;
        if (vaultData.pinnedProfileId === id) {
          vaultData.pinnedProfileId = '';
          toast('📌 기본 API 고정을 해제했습니다.', 'info');
        } else {
          vaultData.pinnedProfileId = id;
          vaultData.activeProfileId = id;
          toast('📌 기본 API로 고정했습니다! 앱 재시작·새 API 추가 시에도 유지됩니다.', 'info');
        }
        await persistVault();
        renderAllAIViews();
        return;
      }
      const editBtn = e.target.closest('[data-ai-edit]');
      if (editBtn) {
        if (vaultData.editLocked) { toast('🔒 키 편집 잠금이 켜져 있습니다. 먼저 잠금을 해제하세요.', 'warn'); return; }
        const p = (vaultData.profiles || []).find((x) => x.id === editBtn.dataset.aiEdit);
        if (p) loadProfileIntoForm(p);
        return;
      }
      const delBtn = e.target.closest('[data-ai-del]');
      if (delBtn) {
        if (vaultData.editLocked) { toast('🔒 키 편집 잠금이 켜져 있습니다. 먼저 잠금을 해제하세요.', 'warn'); return; }
        const id = delBtn.dataset.aiDel;
        vaultData.profiles = (vaultData.profiles || []).filter((x) => x.id !== id);
        if (vaultData.pinnedProfileId === id) vaultData.pinnedProfileId = '';
        if (vaultData.activeProfileId === id) { stopLiveSession(true); vaultData.activeProfileId = 'builtin'; }
        if (editingProfileId === id) loadProfileIntoForm(null);
        await persistVault();
        renderAllAIViews();
        toast('프로필을 삭제했습니다.', 'info');
        return;
      }
      const testBtn = e.target.closest('[data-ai-test]');
      if (testBtn) {
        const p = (vaultData.profiles || []).find((x) => x.id === testBtn.dataset.aiTest);
        if (p) runProbeWithUI(p, 'vf-test-result');
      }
    });

    document.getElementById('btn-vf-test').addEventListener('click', () => runProbeWithUI(readFormAsProfile(), 'vf-test-result'));
    document.getElementById('btn-vf-save').addEventListener('click', async () => {
      if (!vaultUnlocked) { toast('먼저 앱 비밀번호를 설정·잠금해제해 주세요.', 'warn'); return; }
      if (vaultData.editLocked) { toast('🔒 키 편집 잠금을 먼저 해제해 주세요.', 'warn'); return; }
      const draft = readFormAsProfile();
      if (!draft.name || !draft.model) { toast('프로필 이름과 모델명을 입력해 주세요.', 'warn'); return; }
      if (editingProfileId) {
        const idx = vaultData.profiles.findIndex((x) => x.id === editingProfileId);
        if (idx >= 0) vaultData.profiles[idx] = draft;
        else vaultData.profiles.push(draft);
      } else {
        vaultData.profiles.push(draft);
      }
      // Respect pinnedProfileId! Only auto-switch active profile if nothing is pinned.
      if (isProfileReady(draft) && !vaultData.pinnedProfileId) {
        vaultData.activeProfileId = draft.id;
      }
      try {
        await persistVault();
        loadProfileIntoForm(null);
        renderAllAIViews();
        toast(`「${draft.name}」 프로필을 AES-GCM-256으로 암호화 저장했습니다!`, 'info');
      } catch (err) {
        toast('암호화 저장 실패: ' + err.message, 'error');
      }
    });

    // Dedicated Backup Failover API Events
    document.getElementById('btn-bk-test').addEventListener('click', () => runProbeWithUI(readBackupForm(), 'bk-test-result'));
    document.getElementById('btn-bk-save').addEventListener('click', async () => {
      if (!vaultUnlocked) { toast('먼저 앱 비밀번호를 설정·잠금해제해 주세요.', 'warn'); return; }
      if (vaultData.editLocked) { toast('🔒 키 편집 잠금을 먼저 해제해 주세요.', 'warn'); return; }
      vaultData.backupApi = readBackupForm();
      try {
        await persistVault();
        renderAllAIViews();
        toast('🛡️ 예비 API 설정을 AES-GCM-256으로 암호화 저장했습니다!', 'info');
      } catch (err) {
        toast('예비 API 저장 실패: ' + err.message, 'error');
      }
    });

    // Gemini Live Style & Earphone Bridge Events
    const saveLiveStyle = () => {
      prefs.liveReplyLength = document.getElementById('pref-live-length').value;
      prefs.liveSpeedHint = document.getElementById('pref-live-speed').value;
      prefs.liveStartMuted = document.getElementById('pref-live-muted').checked;
      prefs.useAudioElementBridge = document.getElementById('pref-audio-bridge').checked;
      savePrefs();
      toast('Gemini Live 스타일·오디오 설정이 저장되었습니다 (다음 세션부터 반영)', 'info');
    };
    document.getElementById('pref-live-length').addEventListener('change', saveLiveStyle);
    document.getElementById('pref-live-speed').addEventListener('change', saveLiveStyle);
    document.getElementById('pref-live-muted').addEventListener('change', saveLiveStyle);
    document.getElementById('pref-audio-bridge').addEventListener('change', saveLiveStyle);

    // Display Prefs Events
    document.getElementById('pref-theme-select').addEventListener('change', (e) => {
      prefs.theme = e.target.value;
      savePrefs();
      applyDisplayPrefs();
      renderHubSummaryBadges();
      toast(prefs.theme === 'dark' ? '🌙 다크 모드가 적용되었습니다' : '☀️ 라이트 모드가 적용되었습니다', 'info');
    });
    document.getElementById('pref-jp-font-select').addEventListener('change', (e) => {
      prefs.jpFontSize = e.target.value;
      savePrefs();
      applyDisplayPrefs();
      renderHubSummaryBadges();
      toast('일본어 글자 크기가 변경되었습니다', 'info');
    });

    // Learning Defaults Events
    document.getElementById('btn-save-learning-defaults').addEventListener('click', () => {
      const b = bridge();
      const st = b && b.getState ? b.getState() : null;
      if (!st) return;
      st.user.nickname = document.getElementById('ld-nickname').value.trim() || '일본어 학습자';
      st.dailyTarget = Math.max(3, Math.min(30, parseInt(document.getElementById('ld-daily-target').value, 10) || 6));
      st.speakingRegister = document.getElementById('ld-register').value === 'casual' ? 'casual' : 'polite';
      st.listenSpeed = parseFloat(document.getElementById('ld-listen-speed').value) || 1.0;
      st.vocabShowFurigana = document.getElementById('ld-vocab-furi').checked;
      st.listenShowFurigana = document.getElementById('ld-listen-furi').checked;
      st.listenShowKo = document.getElementById('ld-listen-ko').checked;
      st.autoTts = document.getElementById('ld-auto-tts').checked;
      b.persistState();
      b.renderAll();
      renderHubSummaryBadges();
      toast('학습 기본값이 저장되었습니다!', 'info');
    });

    // Reminder Events
    document.getElementById('btn-rem-save').addEventListener('click', async () => {
      prefs.reminderEnabled = document.getElementById('rem-enabled').checked;
      prefs.reminderTime = document.getElementById('rem-time').value || '21:00';
      prefs.reminderMessage = document.getElementById('rem-message').value.trim() || DEFAULT_PREFS.reminderMessage;
      savePrefs();
      await syncDailyReminderSchedule(true);
      renderHubSummaryBadges();
    });
    document.getElementById('btn-rem-test').addEventListener('click', sendTestReminderNotification);

    // JSON Backup Restore Event
    const restoreInput = document.getElementById('import-backup-json-input');
    if (restoreInput) {
      restoreInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || ''));
            const b = bridge();
            if (b && b.restoreLearningData) {
              b.restoreLearningData(parsed);
              renderAllAIViews();
              refreshAppInfoUI();
              toast('학습 기록 JSON 복원이 완료되었습니다! (비밀번호·암호화 API 키는 안전하게 유지됨)', 'info');
            }
          } catch (err) {
            toast('JSON 백업 파일 형식이 올바르지 않습니다: ' + err.message, 'error');
          }
          e.target.value = '';
        };
        reader.readAsText(file, 'utf-8');
      });
    }

    document.getElementById('btn-clear-cache-only').addEventListener('click', clearCacheOnlyKeepData);

    loadProfileIntoForm(null);
    settingsHubReady = true;
    renderSettingsRouter(false);
  }

  function boot() {
    applyDisplayPrefs();
    try { injectSpeakingBar(); } catch (e) { console.error('[KotonohaAI] injectSpeakingBar:', e); }
    try { setupSettingsHub(); } catch (e) { console.error('[KotonohaAI] setupSettingsHub:', e); }
    startWebReminderTicker();
    renderAllAIViews();
  }

  // ---------- Public Lifecycle Hooks called by index.html ----------
  window.KotonohaAI = {
    onPasswordSetup: (pw) => unlockVaultWithPassword(pw),
    onPasswordUnlock: (pw) => unlockVaultWithPassword(pw),
    onPasswordChange: (newPw, hadBefore) => reencryptVaultWithNewPassword(newPw, hadBefore),
    onGuestEnter: () => lockVaultAndClearMemory(),
    onAppLock: () => lockVaultAndClearMemory(),
    onClearAllData: () => wipeVaultStorage(),
    onScenarioChange: () => {
      if (isLiveActive && !isFreeTalkMode()) {
        stopLiveSession(false);
        toast('에피소드가 변경되어 실시간 세션을 종료했습니다. 새 에피소드로 다시 시작해 주세요.', 'info');
      }
    },
    onSpeakingModeChange: () => {
      if (isLiveActive) {
        stopLiveSession(false);
        toast('회화 모드가 변경되어 실시간 세션을 종료했습니다. 다시 시작해 주세요.', 'info');
      }
    },
    onNavChange: (navId) => {
      if (navId === 'security') {
        if (explicitSubpageTarget && SETTINGS_PAGES[explicitSubpageTarget]) {
          currentSettingsPage = explicitSubpageTarget;
          explicitSubpageTarget = null;
        } else {
          currentSettingsPage = 'hub';
        }
      }
      setTimeout(() => {
        renderAllAIViews();
        if (navId === 'security') renderSettingsRouter(true);
      }, 0);
    },
    openSettings: openSettingsPage,
    replayLiveAudio,
    canAutoTranslate,
    translateUserTurnIfPossible,
    generateScenarioVocabWithAI,
    handleChatInput,
    startLive: startLiveSession,
    stopLive: () => stopLiveSession(false)
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
