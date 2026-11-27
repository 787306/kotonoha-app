#!/usr/bin/env python3
"""
Pre-generates studio-grade native Japanese Neural MP3 audio files using
Microsoft Azure Neural Voices (ja-JP-NanamiNeural & ja-JP-KeitaNeural) via edge-tts.
100% Free, zero API key required. Output goes into www/audio/<fnv1a_hash>.mp3.
"""
import asyncio, json, os, re, sys

JP_TTS_PRONUNCIATION_FIXES = [('温め', 'あたため'), ('寒気', 'さむけ'), ('下道', 'したみち'), ('背筋', 'はいきん'), ('十八番', 'おはこ'), ('手水舎', 'ちょうずや'), ('映える', 'ばえる'), ('上座', 'かみざ'), ('下座', 'しもざ'), ('お冷', 'おひや'), ('老舗', 'しにせ'), ('目処', 'めど'), ('十分です', 'じゅうぶんです'), ('十分あり', 'じゅうぶんあり'), ('十分ほど', 'じゅっぷんほど'), ('十分以内', 'じゅっぷんいない'), ('十分前', 'じゅっぷんまえ'), ('あと十分', 'あとじゅっぷん'), ('辛いので', 'からいので'), ('辛いけど', 'からいけど'), ('辛めの', 'からめの'), ('空いて', 'あいて'), ('開いて', 'あいて'), ('中近両用', 'ちゅうきんりょうよう'), ('近々両用', 'きんきんりょうよう'), ('大盛り', 'おおもり'), ('お通し', 'おとおし'), ('日持ち', 'ひもち'), ('前髪', 'まえがみ'), ('二重に', 'にじゅうに')]

def normalize_jp_tts(text: str) -> str:
    out = str(text or '').strip()
    for src, dst in JP_TTS_PRONUNCIATION_FIXES:
        if src in out:
            out = out.replace(src, dst)
    return out

VOICE_FEMALE = "ja-JP-NanamiNeural"
VOICE_MALE = "ja-JP-KeitaNeural"

def fnv1a_hex(text: str) -> str:
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"

def collect_phrases(html_path: str):
    html = open(html_path, encoding="utf-8").read()
    m_sc = re.search(r"const SCENARIOS = (\{.*?\});\n      const EXTRA_CORE_VOCAB", html, re.S)
    m_ex = re.search(r"const EXTRA_CORE_VOCAB = (\[.*?\]);", html, re.S)
    if not m_sc or not m_ex:
        print("ERROR: Could not locate SCENARIOS/EXTRA_CORE_VOCAB in index.html")
        sys.exit(1)

    scenarios = json.loads(m_sc.group(1))
    extra = json.loads(m_ex.group(1))

    # Map hash -> (text, voice)
    items = {}
    def add(txt, voice=VOICE_FEMALE):
        t = str(txt or "").strip()
        if not t:
            return
        k = fnv1a_hex(t)
        if k not in items:
            items[k] = (t, voice)

    # Test sentence & Free Talk built-in phrases (openings, quick replies, rescues, offline replies)
    add("こんにちは！今日も楽しく日本語を練習しましょう。", VOICE_FEMALE)
    for ft_phrase in [
        "こんにちは！何でも自由に話しましょう。今日はどんなお話をしますか？",
        "やっほー！今日は何でも自由に話そうよ！最近何か面白いことあった？",
        "なるほど、面白いですね！もう少し詳しく教えていただけますか？",
        "へえ、面白いね！もっと詳しく教えてよ！",
        "こんにちは！最近どうですか？",
        "今日あったことを話したいです。",
        "日本の旅行先でおすすめはありますか？",
        "もう少しゆっくり話してください。",
        "やあ！最近どう？",
        "今日あったこと聞いてよ！",
        "おすすめの日本グルメある？",
        "もうちょっとゆっくり話してくれる？",
        "もう少しゆっくり話していただけますか？",
        "もう一度お願いできますか？",
        "もう一回言ってくれる？",
        "これは日本語で何と言いますか？",
        "これって日本語でなんて言うの？",
        "最近どうお過ごしですか？",
        "最近どんな感じ？",
        "別のテーマで話しましょうか？",
        "別の話しようか！",
        "面白いですね！もっと教えてください。",
        "面白いね！もっと教えてよ！"
    ]:
        add(ft_phrase, VOICE_FEMALE)

    for v in extra:
        add(v.get("word"), VOICE_FEMALE)
        add(v.get("exPlain"), VOICE_FEMALE)

    for sc in scenarios.values():
        for v in sc.get("vocab", []):
            add(v.get("word"), VOICE_FEMALE)
            add(v.get("exPlain"), VOICE_FEMALE)
        for g in sc.get("grammar", []):
            add("".join(g.get("answer", [])), VOICE_FEMALE)
            add(g.get("polite"), VOICE_FEMALE)
            add(g.get("casual"), VOICE_FEMALE)
        for d in sc.get("dialogue", []):
            v_pick = VOICE_MALE if d.get("speaker") == "나" else VOICE_FEMALE
            add(d.get("plain"), v_pick)
        rp = sc.get("roleplay", {})
        for key in ("openingPolite", "openingCasual", "fallbackPolite", "fallbackCasual"):
            if key in rp:
                add(rp[key].get("jp"), VOICE_FEMALE)
        for q in rp.get("quickRepliesPolite", []) + rp.get("quickRepliesCasual", []):
            add(q, VOICE_FEMALE)
        for r in rp.get("rescues", []):
            add(r.get("polite"), VOICE_FEMALE)
            add(r.get("casual"), VOICE_FEMALE)
        for rule in rp.get("replyRules", []):
            if "polite" in rule:
                add(rule["polite"].get("jp"), VOICE_FEMALE)
            if "casual" in rule:
                add(rule["casual"].get("jp"), VOICE_FEMALE)
    # Also collect expanded situation vocabulary from www/vocab-expansion.js if present
    exp_path = os.path.join(os.path.dirname(html_path), "vocab-expansion.js")
    if os.path.exists(exp_path):
        exp_txt = open(exp_path, encoding="utf-8").read()
        m_exp = re.search(r"window\.KOTONOHA_VOCAB_EXPANSION\s*=\s*(\{.*\});", exp_txt, re.S)
        if m_exp:
            exp_map = json.loads(m_exp.group(1))
            for vlist in exp_map.values():
                for v in vlist:
                    add(v.get("word"), VOICE_FEMALE)
                    add(v.get("exPlain"), VOICE_FEMALE)
    # Also collect 3-set textbook dialogues from www/textbook-dialogues.js if present
    tb_path = os.path.join(os.path.dirname(html_path), "textbook-dialogues.js")
    if os.path.exists(tb_path):
        tb_txt = open(tb_path, encoding="utf-8").read()
        m_tb = re.search(r"window\.KOTONOHA_TEXTBOOK_DIALOGUES\s*=\s*(\{.*\});", tb_txt, re.S)
        if m_tb:
            tb_map = json.loads(m_tb.group(1))
            for sets in tb_map.values():
                for st in sets:
                    for ln in st.get("lines", []):
                        v_pick = VOICE_MALE if ln.get("speaker") == "나" else VOICE_FEMALE
                        add(ln.get("plain"), v_pick)
    return items

async def synthesize_all():
    import edge_tts
    html_path = os.path.join("www", "index.html")
    out_dir = os.path.join("www", "audio")
    os.makedirs(out_dir, exist_ok=True)
    items = collect_phrases(html_path)
    print(f"Total unique Japanese phrases to synthesize (Azure Neural): {len(items)}")

    sem = asyncio.Semaphore(12)
    ok_count = 0
    fail_count = 0

    async def worker(h, text, voice):
        nonlocal ok_count, fail_count
        out_file = os.path.join(out_dir, f"{h}.mp3")
        if os.path.exists(out_file) and os.path.getsize(out_file) > 500:
            ok_count += 1
            return
        async with sem:
            for attempt in range(3):
                try:
                    comm = edge_tts.Communicate(normalize_jp_tts(text), voice)
                    await comm.save(out_file)
                    if os.path.exists(out_file) and os.path.getsize(out_file) > 200:
                        ok_count += 1
                        return
                except Exception:
                    await asyncio.sleep(0.5 * (attempt + 1))
            fail_count += 1

    await asyncio.gather(*(worker(h, t, v) for h, (t, v) in items.items()))
    print(f"Azure Neural Japanese Audio Generation Done: {ok_count} OK, {fail_count} failed.")

if __name__ == "__main__":
    asyncio.run(synthesize_all())
