/* ═══════════════════════════════════════════════════════════════════════════
   [AI-AGENT-OFFLINE v1] — النواة: الإعدادات + الأدوات المحلية + محرك البحث
   وكيل ذكاء اصطناعي محلي بالكامل. لا شبكة، لا سحابة، لا APIs خارجية.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__AI_AGENT_OFFLINE_V1__) return;
  window.__AI_AGENT_OFFLINE_V1__ = true;

  /* ═════════════════════ 0) أدوات مساعدة عامة ═════════════════════ */
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const toEn = (s) => String(s == null ? '' : s).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  const toAr = (s) => toEn(s).replace(/\d/g, (d) => AR_DIGITS[+d]);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  /** تطبيع عربي موحّد — مطابق لمنطق الموسوعة (normalizeText) لضمان تطابق النتائج */
  function norm(t) {
    if (t == null) return '';
    return String(t).normalize('NFKC')
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
      .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, 'ا')
      .replace(/[ةه]/g, 'ه')
      .replace(/[يى]/g, 'ي')
      .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED\u0670]/g, '')
      .replace(/\u0640/g, '')
      .replace(/[\u060C\u061B\u061F\u066A-\u066D.,;:!?"'()\[\]{}«»…\-_/\\|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** جذور تقريبية: إزالة السوابق الشائعة (و، ال، بال، وال…) لتوسيع المطابقة */
  function lightStem(w) {
    let x = w;
    if (x.length > 4) x = x.replace(/^(وال|بال|فال|كال|ال|و|ف|ب|ك|ل)/, '');
    return x.length >= 2 ? x : w;
  }
  function tokens(t) {
    return norm(t).split(' ').filter((w) => w.length > 1).map(lightStem);
  }

  /* ═════════════════════ 1) الإعدادات (تُحفظ محلياً) ═════════════════════ */
  const LS = {
    cfg: 'ai_agent_cfg_v1',
    notes: 'ai_agent_notes_v1',
    chat: 'ai_agent_chat_v1',
    prompt: 'ai_agent_prompt_v1'
  };

  const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
  const DEFAULT_MODEL = 'qwen2.5:7b';

  const CFG = {
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    temperature: 0.2,
    numCtx: 8192,
    maxRounds: 6,
    topK: 8,
    stream: true,
    scanBudget: 600
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS.cfg);
      if (raw) Object.assign(CFG, JSON.parse(raw) || {});
    } catch (e) { /* تجاهل */ }
    return CFG;
  }
  function saveCfg() {
    try { localStorage.setItem(LS.cfg, JSON.stringify(CFG)); } catch (e) { /* تجاهل */ }
  }

  /* ═════════════════════ 2) حارس OFFLINE_ONLY ═════════════════════
     أي عنوان غير محلي يُرفض تلقائياً قبل خروج الطلب. هذا تطبيق صارم لسياسة
     الوضع التشغيلي OFFLINE_ONLY: لا شبكة، لا API خارجي، لا خدمة سحابية. */
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]']);
  function assertLocalEndpoint(url) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('عنوان المحرك غير صالح: ' + url); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('بروتوكول غير مدعوم: ' + u.protocol);
    if (!LOCAL_HOSTS.has(u.hostname)) {
      throw new Error(
        'OFFLINE_ONLY: العنوان «' + u.hostname + '» خارجي ومرفوض تلقائياً. ' +
        'الوكيل يتصل فقط بمحرك محلي (127.0.0.1 أو localhost).'
      );
    }
    return u.origin;
  }

  /* ═════════════════════ 3) الوصول لبيانات الموسوعة ═════════════════════
     كل الوصول محلي: IndexedDB (Dexie) + المصفوفة في الذاكرة + JSON المضمّن. */

  function getDocsArray() {
    try { if (Array.isArray(window.allAppeals) && window.allAppeals.length) return window.allAppeals; } catch (e) { /* */ }
    try { if (typeof allAppeals !== 'undefined' && Array.isArray(allAppeals)) return allAppeals; } catch (e) { /* */ }
    return [];
  }

  async function getDocsFromDB() {
    try {
      const db = window.db;
      if (!db || !db.appeals) return null;
      const rows = await db.appeals.toArray();
      return Array.isArray(rows) ? rows : null;
    } catch (e) { return null; }
  }

  /** يجمع الفهرسة الوصفية من أنسب مصدر متاح (الأحدث يفوز) */
  async function loadCatalog() {
    const fromDB = await getDocsFromDB();
    const mem = getDocsArray();
    const src = (fromDB && fromDB.length) ? fromDB : mem;
    return src.filter((a) => a && a.id != null);
  }

  async function getContent(id) {
    try {
      if (typeof window.getAppealContent === 'function') {
        const c = await window.getAppealContent(id);
        if (c) return String(c);
      }
    } catch (e) { /* */ }
    try {
      if (typeof getAppealContent === 'function') {
        const c = await getAppealContent(id);
        if (c) return String(c);
      }
    } catch (e) { /* */ }
    try {
      const db = window.db;
      if (db && db.appeals) {
        const r = await db.appeals.get(id);
        if (r && r.content) return String(r.content);
      }
    } catch (e) { /* */ }
    try {
      const a = getDocsArray().find((x) => x.id === id);
      if (a && a.content) return String(a.content);
    } catch (e) { /* */ }
    return '';
  }

  let _legisCache = null;
  function getLegis() {
    if (_legisCache) return _legisCache;
    try {
      const el = document.getElementById('legis-data');
      _legisCache = el ? JSON.parse(el.textContent) : null;
    } catch (e) { _legisCache = null; }
    return _legisCache;
  }
  let _statusCache = null;
  function getLegisStatus() {
    if (_statusCache) return _statusCache;
    try {
      if (window.LEGIS_STATUS && window.LEGIS_STATUS.status) { _statusCache = window.LEGIS_STATUS; return _statusCache; }
    } catch (e) { /* */ }
    try {
      const el = document.getElementById('legis-status');
      _statusCache = el ? JSON.parse(el.textContent) : null;
    } catch (e) { _statusCache = null; }
    return _statusCache;
  }
  let _pageMapCache = null;
  function getPageMap() {
    if (_pageMapCache) return _pageMapCache;
    try {
      const el = document.getElementById('legis-pagemap');
      _pageMapCache = el ? JSON.parse(el.textContent) : null;
    } catch (e) { _pageMapCache = null; }
    return _pageMapCache;
  }

  const LAWS = {
    proc: { ar: 'قانون الإجراءات الجنائية ١٧٤ لسنة ٢٠٢٥', pdf: 'proc' },
    penal: { ar: 'قانون العقوبات', pdf: 'penal' }
  };

  /* ═════════════════════ 4) محرك BM25 محلي (بلا شبكة) ═════════════════════ */
  function buildBM25(docs, getText) {
    const N = docs.length;
    const df = new Map();
    const lens = new Array(N);
    const tfs = new Array(N);
    let totalLen = 0;
    for (let i = 0; i < N; i++) {
      const toks = tokens(getText(docs[i], i));
      lens[i] = toks.length;
      totalLen += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      tfs[i] = tf;
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    const avgdl = N ? totalLen / N : 1;
    const k1 = 1.5, b = 0.75;
    return {
      N, avgdl,
      score(i, qTokens) {
        const tf = tfs[i]; if (!tf) return 0;
        const dl = lens[i] || 1;
        let s = 0;
        for (const q of qTokens) {
          const f = tf.get(q); if (!f) continue;
          const n = df.get(q) || 0;
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
        }
        return s;
      }
    };
  }

  function makeSnippet(text, qTokens, radius) {
    const R = radius || 340;
    const plain = String(text || '').replace(/[ \t]+/g, ' ');
    if (!plain) return '';
    const nText = norm(plain);
    let best = -1, bestHits = 0;
    for (const q of qTokens.slice(0, 6)) {
      const idx = nText.indexOf(q);
      if (idx < 0) continue;
      // نقدّر الموضع في النص الأصلي بنسبة الطول
      const ratio = plain.length / Math.max(1, nText.length);
      const p = Math.round(idx * ratio);
      let hits = 0;
      for (const q2 of qTokens) if (nText.slice(Math.max(0, idx - 200), idx + 200).includes(q2)) hits++;
      if (hits > bestHits) { bestHits = hits; best = p; }
    }
    if (best < 0) return plain.slice(0, R * 2).trim();
    const s = Math.max(0, best - R), e = Math.min(plain.length, best + R);
    return (s > 0 ? '… ' : '') + plain.slice(s, e).trim() + (e < plain.length ? ' …' : '');
  }

  /* ═════════════════════ 5) الأدوات المحلية (Tools) ═════════════════════
     كل أداة: { name, description, parameters, run(args) } — نتائجها JSON حقيقي
     مُتحقَّق منه من البيانات المحلية. لا تُخترع نتائج إطلاقاً. */

  const TOOLS = [];
  const TOOL_MAP = new Map();
  function defineTool(t) { TOOLS.push(t); TOOL_MAP.set(t.name, t); }

  /* ── 5.1 البحث في الموسوعة (BM25 + فهرسة مسبقة) ── */
  defineTool({
    name: 'search_encyclopedia',
    description:
      'البحث الدلالي/الكلماتي (BM25) في نصوص أحكام النقض والمذكرات المفهرسة داخل الموسوعة المحلية. ' +
      'استخدمها أولاً لأي سؤال عن الأحكام أو المبادئ أو المذكرات. تُعيد قائمة مختصرة (id، اسم الملف، المجلد، النوع، الدرجة، مقتطف). ' +
      'ثم استخدم get_document لقراءة نص أي مستند بالكامل.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'عبارة البحث بالعربية' },
        limit: { type: 'integer', description: 'عدد النتائج (افتراضي من الإعدادات)' },
        doc_type: { type: 'string', enum: ['حكم', 'مذكرة', 'الكل'], description: 'تصفية بنوع المستند' },
        folder: { type: 'string', description: 'تصفية بمجلد معيّن (اختياري)' },
        crime_type: { type: 'string', description: 'تصفية بنوع الجريمة (اختياري)' }
      },
      required: ['query']
    },
    async run(args) {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, error: 'عبارة البحث فارغة' };
      const limit = clamp(parseInt(args.limit, 10) || CFG.topK, 1, 50);
      const catalog = await loadCatalog();
      if (!catalog.length) {
        return { ok: false, error: 'لا توجد مستندات مفهرسة في الموسوعة المحلية. ارفع ملفات DOCX أولاً أو انتظر اكتمال تحميل قاعدة البيانات.' };
      }

      // 1) تصفية وصفية أولاً (رخيصة)
      let pool = catalog;
      if (args.doc_type && args.doc_type !== 'الكل') {
        const dt = norm(args.doc_type);
        pool = pool.filter((a) => norm(a.docType || '').includes(dt));
      }
      if (args.folder) {
        const f = norm(args.folder);
        pool = pool.filter((a) => norm(a.folder || '').includes(f));
      }
      if (args.crime_type) {
        const c = norm(args.crime_type);
        pool = pool.filter((a) => norm(a.crimeType || '').includes(c));
      }

      const qT = tokens(q);
      if (!qT.length) return { ok: false, error: 'عبارة البحث لا تحتوي كلمات صالحة' };

      // 2) استرجاع مرشّحين سريع من FlexSearch إن توفّر (فهرس المحتوى الجاهز)
      let candidates = pool;
      let usedFlex = false;
      try {
        const fx = window.flexIndex;
        if (fx && typeof fx.search === 'function') {
          const res = fx.search(q, { limit: Math.max(60, limit * 12), suggest: true });
          const ids = new Set();
          if (Array.isArray(res)) {
            res.forEach((r) => { if (r && Array.isArray(r.result)) r.result.forEach((id) => ids.add(id)); });
          }
          if (ids.size) {
            const filtered = pool.filter((a) => ids.has(a.id));
            if (filtered.length >= limit) { candidates = filtered; usedFlex = true; }
          }
        }
      } catch (e) { /* نكمل بالبحث الكامل */ }

      // 3) اسناد BM25 على نصوص المرشّحين (مع سقف مسح معلن — لا ندّعي مسحاً كاملاً)
      const budget = clamp(parseInt(args.__budget, 10) || CFG.scanBudget, 20, 5000);
      const toScan = candidates.slice(0, budget);
      const scanned = toScan.length;

      const texts = new Array(toScan.length);
      const BATCH = 40;
      for (let i = 0; i < toScan.length; i += BATCH) {
        const batch = toScan.slice(i, i + BATCH);
        const got = await Promise.all(batch.map((a) => getContent(a.id).catch(() => '')));
        for (let j = 0; j < got.length; j++) texts[i + j] = got[j] || '';
      }

      // دمج الاسم والمجلد في النص المُسند (وزن أخف)
      const bm = buildBM25(toScan, (a, i) => (a.fileName || '') + ' ' + (a.folder || '') + ' ' + (texts[i] || ''));

      const hits = [];
      for (let i = 0; i < toScan.length; i++) {
        const s = bm.score(i, qT);
        if (s <= 0) continue;
        hits.push({ i, s, a: toScan[i] });
      }
      hits.sort((x, y) => y.s - x.s);
      const top = hits.slice(0, limit);

      return {
        ok: true,
        query: q,
        scanned_documents: scanned,
        total_matching: hits.length,
        total_in_encyclopedia: catalog.length,
        retrieval: usedFlex ? 'flexsearch + bm25' : 'bm25',
        note: scanned < candidates.length
          ? ('ملاحظة صدق: فُحص ' + toAr(scanned) + ' مستنداً من ' + toAr(candidates.length) + ' مطابقاً وصفياً بسقف المسح الحالي. النتائج ليست مسحاً شاملاً.')
          : 'تم فحص كل المستندات المطابقة وصفياً.',
        results: top.map((h, idx) => ({
          rank: idx + 1,
          id: h.a.id,
          file_name: h.a.fileName || ('مستند ' + h.a.id),
          folder: h.a.folder || 'عام',
          doc_type: h.a.docType || '',
          file_type: h.a.fileType || '',
          crime_type: h.a.crimeType || '',
          score: Math.round(h.s * 100) / 100,
          snippet: makeSnippet(texts[h.i] || '', qT, 320)
        }))
      };
    }
  });

  /* ── 5.2 قراءة مستند كامل ── */
  defineTool({
    name: 'get_document',
    description:
      'قراءة النص الكامل لمستند واحد من الموسوعة بمعرّفه (id). استخدمها بعد search_encyclopedia لتحليل نص حكم أو مذكرة. ' +
      'تدعم التقسيم عبر offset/length للمستندات الطويلة جداً.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'معرّف المستند من نتائج البحث' },
        offset: { type: 'integer', description: 'موضع بداية القراءة (افتراضي 0)' },
        length: { type: 'integer', description: 'عدد الحروف المطلوبة (افتراضي 12000، أقصى 40000)' }
      },
      required: ['id']
    },
    async run(args) {
      const id = parseInt(args.id, 10);
      if (!id) return { ok: false, error: 'معرّف غير صالح' };
      const catalog = await loadCatalog();
      const meta = catalog.find((a) => a.id === id);
      const content = await getContent(id);
      if (!content) {
        return { ok: false, error: 'لا يوجد نص محفوظ لهذا المستند (id=' + id + '). قد يكون غير مفهرس أو محتواه غير محمّل.' };
      }
      const off = clamp(parseInt(args.offset, 10) || 0, 0, content.length);
      const len = clamp(parseInt(args.length, 10) || 12000, 500, 40000);
      const part = content.slice(off, off + len);
      return {
        ok: true,
        id,
        file_name: meta ? meta.fileName : '',
        folder: meta ? meta.folder : '',
        doc_type: meta ? meta.docType : '',
        crime_type: meta ? meta.crimeType : '',
        total_length: content.length,
        offset: off,
        returned_length: part.length,
        has_more: off + len < content.length,
        text: part
      };
    }
  });

  /* ── 5.3 استعلام وصفوي على قاعدة البيانات المحلية ── */
  defineTool({
    name: 'query_index',
    description: 'استعلام وصفوي مباشر على فهرس قاعدة البيانات المحلية (IndexedDB): تصفية بالمجلد أو النوع أو نوع الجريمة أو سنة الرفع. تُعيد بيانات وصفية فقط بلا نصوص.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string' }, doc_type: { type: 'string' }, crime_type: { type: 'string' },
        file_type: { type: 'string' },
        year_from: { type: 'integer' }, year_to: { type: 'integer' },
        limit: { type: 'integer', description: 'افتراضي 50، أقصى 500' }
      }
    },
    async run(args) {
      const catalog = await loadCatalog();
      let rows = catalog;
      const has = (v) => v != null && String(v).trim() !== '';
      if (has(args.folder)) { const f = norm(args.folder); rows = rows.filter((a) => norm(a.folder || '').includes(f)); }
      if (has(args.doc_type)) { const d = norm(args.doc_type); rows = rows.filter((a) => norm(a.docType || '').includes(d)); }
      if (has(args.crime_type)) { const c = norm(args.crime_type); rows = rows.filter((a) => norm(a.crimeType || '').includes(c)); }
      if (has(args.file_type)) { const t = norm(args.file_type); rows = rows.filter((a) => norm(a.fileType || '').includes(t)); }
      if (has(args.year_from) || has(args.year_to)) {
        rows = rows.filter((a) => {
          const y = new Date(a.uploadDate || 0).getFullYear();
          if (!y) return false;
          if (has(args.year_from) && y < +args.year_from) return false;
          if (has(args.year_to) && y > +args.year_to) return false;
          return true;
        });
      }
      const limit = clamp(parseInt(args.limit, 10) || 50, 1, 500);
      return {
        ok: true,
        matched: rows.length,
        returned: Math.min(limit, rows.length),
        rows: rows.slice(0, limit).map((a) => ({
          id: a.id, file_name: a.fileName, folder: a.folder, doc_type: a.docType,
          file_type: a.fileType, crime_type: a.crimeType,
          upload_date: a.uploadDate ? new Date(a.uploadDate).toISOString().slice(0, 10) : ''
        }))
      };
    }
  });

  /* ── 5.4 إحصاءات قاعدة البيانات ── */
  defineTool({
    name: 'db_stats',
    description: 'إحصاءات قاعدة البيانات المحلية: العدد الإجمالي، والتوزيع بحسب النوع والمجلد ونوع الجريمة ونوع الملف. مفيدة لتقرير حالة الموسوعة.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const catalog = await loadCatalog();
      const count = (key) => {
        const m = {};
        catalog.forEach((a) => { const v = String(a[key] || 'غير محدد').trim() || 'غير محدد'; m[v] = (m[v] || 0) + 1; });
        return Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1]));
      };
      const legis = getLegis();
      return {
        ok: true,
        encyclopedia: {
          total_documents: catalog.length,
          by_doc_type: count('docType'),
          by_file_type: count('fileType'),
          by_folder: count('folder'),
          by_crime_type: count('crimeType')
        },
        legislation: legis ? {
          criminal_procedure_articles: (legis.proc || []).length,
          penal_code_articles: (legis.penal || []).length,
          meta: legis.meta || {}
        } : { available: false }
      };
    }
  });

  /* ── 5.5 قائمة المجلدات ── */
  defineTool({
    name: 'list_folders',
    description: 'سرد مجلدات الموسوعة مع عدد الملفات في كل مجلد.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const catalog = await loadCatalog();
      const m = {};
      catalog.forEach((a) => { const f = a.folder || 'عام'; m[f] = (m[f] || 0) + 1; });
      const folders = Object.entries(m).map(([name, n]) => ({ folder: name, files: n })).sort((a, b) => b.files - a.files);
      return { ok: true, total_folders: folders.length, folders: folders.slice(0, 300) };
    }
  });

  /* ── 5.6 البحث في نصوص التشريعات (٥٤٦ إجراءات + ٥٣٩ عقوبات) ── */
  defineTool({
    name: 'search_legislation',
    description:
      'البحث النصي (BM25) في مواد قانون الإجراءات الجنائية ١٧٤ لسنة ٢٠٢٥ وقانون العقوبات. ' +
      'استخدمها لسؤال عن نص مادة أو مصطلح تشريعي.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        law: { type: 'string', enum: ['proc', 'penal', 'all'], description: 'proc=الإجراءات، penal=العقوبات، all=الاثنان' },
        limit: { type: 'integer' }
      },
      required: ['query']
    },
    async run(args) {
      const D = getLegis();
      if (!D) return { ok: false, error: 'بيانات التشريعات غير محمّلة في الصفحة.' };
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, error: 'عبارة البحث فارغة' };
      const law = args.law || 'all';
      const limit = clamp(parseInt(args.limit, 10) || CFG.topK, 1, 30);
      const qT = tokens(q);

      const pool = [];
      if (law !== 'penal') (D.proc || []).forEach((a) => pool.push({ kind: 'proc', n: a.n, text: (a.title ? a.title + '\n' : '') + (a.new || ''), old: a.old || '' }));
      if (law !== 'proc') (D.penal || []).forEach((a) => pool.push({ kind: 'penal', n: a.n, text: (a.cls ? a.cls + '\n' : '') + (a.text || ''), old: '' }));

      const bm = buildBM25(pool, (x) => x.text);
      const hits = [];
      for (let i = 0; i < pool.length; i++) { const s = bm.score(i, qT); if (s > 0) hits.push({ i, s }); }
      hits.sort((a, b) => b.s - a.s);
      return {
        ok: true,
        query: q,
        searched_articles: pool.length,
        results: hits.slice(0, limit).map((h) => ({
          law: LAWS[pool[h.i].kind].ar,
          law_key: pool[h.i].kind,
          // توحيد النوع كنص: بعض المواد أرقامها Numeric في العقوبات والنصية في الإجراءات
          article_number: String(pool[h.i].n),
          score: Math.round(h.s * 100) / 100,
          snippet: makeSnippet(pool[h.i].text, qT, 300),
          old_article_refs: pool[h.i].old || undefined
        }))
      };
    }
  });

  /* ── 5.7 نص مادة محدّدة بالرقم ── */
  defineTool({
    name: 'lookup_article',
    description:
      'إحضار النص الحرفي لمادة محدّدة برقمها من قانون الإجراءات الجنائية ١٧٤ لسنة ٢٠٢٥ أو قانون العقوبات، ' +
      'مع الشارات التنظيمية (مستحدثة/مدمجة/معدلة/إعادة ترقيم) والمقابل في القانون الملغى ١٥٠/١٩٥٠ ورقم صفحة الـ PDF الرسمي.',
    parameters: {
      type: 'object',
      properties: {
        law: { type: 'string', enum: ['proc', 'penal'], description: 'proc=الإجراءات الجنائية، penal=العقوبات' },
        article_number: { type: ['integer', 'string'], description: 'رقم المادة' }
      },
      required: ['law', 'article_number']
    },
    async run(args) {
      const D = getLegis();
      if (!D) return { ok: false, error: 'بيانات التشريعات غير محمّلة.' };
      const key = args.law === 'penal' ? 'penal' : 'proc';
      const n = String(toEn(args.article_number)).replace(/\D/g, '');
      if (!n) return { ok: false, error: 'رقم مادة غير صالح' };
      const arr = D[key] || [];
      const art = arr.find((x) => String(x.n) === n);
      if (!art) return { ok: false, error: 'المادة ' + n + ' غير موجودة في ' + LAWS[key].ar + ' (عدد مواد هذا القانون: ' + arr.length + ').' };

      const out = { ok: true, law: LAWS[key].ar, law_key: key, article_number: n };

      if (key === 'proc') {
        out.title = art.title || '';
        out.text = art.new || '';
        out.old_law_equivalent = art.old || '(لا مقابل — مادة مستحدثة)';
        try {
          const st = window.legisArticleStatus ? window.legisArticleStatus(n) : (getLegisStatus() || {}).status?.[n];
          if (st) { out.status_tags = st.tags || []; out.status_note = st.note || ''; out.status_primary = st.p || ''; }
          const o2n = window.legisOldToNew ? window.legisOldToNew(n) : ((getLegisStatus() || {}).oldToNew || {})[n];
          if (o2n && o2n.length) out.linked_new_articles = o2n;
        } catch (e) { /* */ }
      } else {
        out.chapter = art.cls || '';
        out.text = art.text || '';
      }

      try {
        const pm = getPageMap();
        const page = pm && pm[key] ? pm[key][n] : null;
        if (page) { out.pdf_page = page; out.pdf_key = LAWS[key].pdf; }
      } catch (e) { /* */ }

      return out;
    }
  });

  /* ── 5.8 جدول التحويل من القانون الملغى ── */
  defineTool({
    name: 'old_to_new_article',
    description: 'الاستعلام عن أرقام المواد في قانون الإجراءات الجنائية الجديد ١٧٤/٢٠٢٥ التي تقابل مادة محدّدة من قانون الإجراءات الجنائية الملغى ١٥٠/١٩٥٠.',
    parameters: {
      type: 'object',
      properties: { old_article_number: { type: ['integer', 'string'], description: 'رقم المادة في القانون الملغى ١٥٠/١٩٥٠' } },
      required: ['old_article_number']
    },
    async run(args) {
      const n = String(toEn(args.old_article_number)).replace(/\D/g, '');
      if (!n) return { ok: false, error: 'رقم مادة غير صالح' };
      let news = [];
      try {
        news = window.legisOldToNew ? window.legisOldToNew(n) : [];
      } catch (e) { /* */ }
      if (!news.length) {
        const S = getLegisStatus();
        if (S && S.oldToNew) news = S.oldToNew[n] || [];
      }
      if (!news.length) {
        return {
          ok: true, old_article_number: n, found: false,
          message: 'المادة ' + n + ' من القانون الملغى ١٥٠/١٩٥٠ لا يقابلها نص في القانون الجديد ١٧٤/٢٠٢٥ (أُلغيت دون بديل أو رقمها خارج الجدول).'
        };
      }
      const D = getLegis();
      const details = news.map((x) => {
        const a = D ? (D.proc || []).find((z) => String(z.n) === String(x)) : null;
        return {
          new_article_number: String(x),
          title: a ? (a.title || '') : '',
          excerpt: a ? String(a.new || '').slice(0, 260) : ''
        };
      });
      return { ok: true, old_article_number: n, found: true, new_articles_count: news.length, new_articles: details };
    }
  });

  /* ── 5.9 تحليل نص محلي (حتمي، بلا نموذج) ── */
  defineTool({
    name: 'analyze_text',
    description:
      'تحليل إحصائي حتمي لنص (بلا استخدام النموذج): عدد الكلمات والحروف، أعلى الكلمات تكراراً، ' +
      'واستخراج أرقام المواد القانونية والطعون والتواريخ. مفيد لقراءة سريعة لمستند أو نص مقتطف.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'النص المراد تحليله' },
        document_id: { type: 'integer', description: 'بديل: معرّف مستند من الموسوعة لتحليله' }
      }
    },
    async run(args) {
      let text = String(args.text || '');
      let source = 'نص مُدخل مباشرة';
      if (!text && args.document_id) {
        text = await getContent(parseInt(args.document_id, 10));
        source = 'المستند id=' + args.document_id;
      }
      if (!text) return { ok: false, error: 'لا يوجد نص للتحليل' };

      const words = norm(text).split(' ').filter(Boolean);
      const freq = new Map();
      for (const w of words) { if (w.length < 3) continue; freq.set(w, (freq.get(w) || 0) + 1); }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w, c]) => ({ word: w, count: c }));

      const en = toEn(text);
      const articles = [...new Set((en.match(/(?:الماده|المادة|ماده|مادة)\s*(?:رقم\s*)?\(?\s*(\d{1,4})/g) || [])
        .map((m) => (m.match(/(\d{1,4})/) || [])[1]).filter(Boolean))].slice(0, 60);
      const appeals = [...new Set((en.match(/(?:الطعن|طعن)\s*(?:رقم\s*)?(?:\(?\s*)?(\d{2,6})/g) || [])
        .map((m) => (m.match(/(\d{2,6})/) || [])[1]).filter(Boolean))].slice(0, 40);
      const years = [...new Set((en.match(/\b(19|20)\d{2}\b/g) || []))].sort().slice(0, 30);
      const dates = [...new Set((en.match(/\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}/g) || []))].slice(0, 30);

      return {
        ok: true, source,
        statistics: {
          characters: text.length,
          words: words.length,
          unique_words: freq.size,
          lines: text.split(/\n+/).filter((l) => l.trim()).length,
          avg_word_length: words.length ? Math.round((text.length / words.length) * 100) / 100 : 0
        },
        most_frequent_words: top,
        extracted: {
          article_numbers: articles,
          appeal_numbers: appeals,
          years, dates_found: dates
        }
      };
    }
  });

  /* ── 5.10 قراءة ملف محلي من جهاز المستخدم ── */
  defineTool({
    name: 'read_local_file',
    description:
      'قراءة ملف من جهاز المستخدم محلياً بلا رفع لأي خدمة: يفتح منتقي الملفات ثم يستخرج النص. ' +
      'يدعم TXT / MD / CSV / JSON / DOCX (عبر mammoth المحمّلة) / PDF (عبر محرك PDF المضمّن). ' +
      'يتطلب تفاعلاً من المستخدم لاختيار الملف (قيد أمني من المتصفح).',
    parameters: {
      type: 'object',
      properties: {
        max_chars: { type: 'integer', description: 'أقصى عدد حروف تُعاد (افتراضي 20000)' }
      }
    },
    async run(args) {
      const maxChars = clamp(parseInt(args.max_chars, 10) || 20000, 1000, 60000);
      const file = await pickLocalFile();
      if (!file) return { ok: false, error: 'لم يختر المستخدم أي ملف (أو ألغى العملية).' };
      const res = await extractFileText(file);
      if (!res.ok) return { ok: false, error: res.error, file_name: file.name, size: file.size };
      return {
        ok: true,
        file_name: file.name,
        size_bytes: file.size,
        detected_type: res.kind,
        total_length: res.text.length,
        truncated: res.text.length > maxChars,
        text: res.text.slice(0, maxChars)
      };
    }
  });

  /* ── 5.11 حفظ/قراءة ملاحظات الوكيل محلياً ── */
  defineTool({
    name: 'save_note',
    description: 'حفظ ملاحظة أو خلاصة أو مسودة في مخزن الوكيل المحلي (localStorage) لاستدعائها لاحقاً. للاستخدام مع list_notes.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'string', description: 'وسوم مفصولة بفواصل (اختياري)' },
        source_ids: { type: 'array', items: { type: 'integer' }, description: 'معرّفات المستندات المصدر (اختياري)' }
      },
      required: ['title', 'content']
    },
    async run(args) {
      const notes = loadNotes();
      const note = {
        id: 'n' + Date.now().toString(36),
        title: String(args.title || 'ملاحظة').slice(0, 200),
        content: String(args.content || ''),
        tags: String(args.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        source_ids: Array.isArray(args.source_ids) ? args.source_ids : [],
        created_at: nowISO()
      };
      notes.unshift(note);
      try { localStorage.setItem(LS.notes, JSON.stringify(notes.slice(0, 500))); } catch (e) {
        return { ok: false, error: 'تعذّر الحفظ: مساحة التخزين المحلي ممتلئة.' };
      }
      return { ok: true, note_id: note.id, total_notes: notes.length, message: 'حُفظت الملاحظة محلياً في مخزن الوكيل.' };
    }
  });

  defineTool({
    name: 'list_notes',
    description: 'سرد الملاحظات المحفوظة في مخزن الوكيل المحلي.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    async run(args) {
      const notes = loadNotes();
      const limit = clamp(parseInt(args.limit, 10) || 30, 1, 200);
      return { ok: true, total: notes.length, notes: notes.slice(0, limit) };
    }
  });

  const loadNotes = () => { try { return JSON.parse(localStorage.getItem(LS.notes) || '[]'); } catch (e) { return []; } };

  /* ── 5.12 تصدير مستند ── */
  defineTool({
    name: 'export_document',
    description: 'تصدير نص أو تقرير كملف للتنزيل مباشرة على جهاز المستخدم (Markdown أو نص). لا يُرسل أي شيء لأي جهة خارجية.',
    parameters: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        content: { type: 'string' },
        format: { type: 'string', enum: ['md', 'txt', 'html'] }
      },
      required: ['file_name', 'content']
    },
    async run(args) {
      const fmt = (args.format || 'md').toLowerCase();
      const safeName = String(args.file_name || 'تقرير').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
      const name = safeName + (safeName.endsWith('.' + fmt) ? '' : '.' + fmt);
      const body = String(args.content || '');
      if (!body.trim()) return { ok: false, error: 'المحتوى فارغ، لا شيء للتصدير.' };
      const mime = fmt === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
      const finalText = fmt === 'html'
        ? '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>' + esc(safeName) + '</title></head><body style="font-family:Cairo,Tahoma,sans-serif;line-height:2;padding:2rem;max-width:900px;margin:auto"><pre style="white-space:pre-wrap">' + esc(body) + '</pre></body></html>'
        : '\uFEFF' + body;
      triggerDownload(new Blob([finalText], { type: mime }), name);
      return { ok: true, saved_as: name, format: fmt, bytes: finalText.length, message: 'تم إرسال الملف للتنزيل على جهاز المستخدم.' };
    }
  });

  /* ── 5.13 حساب حتمي ── */
  defineTool({
    name: 'compute',
    description: 'إجراء حسابات رقمية حتمية (بلا نموذج): جمع/متوسط/وسيط/انحراف/نسب/تواريخ. استخدمها بدل الحساب الذهني لتفادي الأخطاء.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['sum', 'avg', 'median', 'min', 'max', 'stdev', 'count', 'percent', 'date_diff'] },
        numbers: { type: 'array', items: { type: 'number' } },
        date_from: { type: 'string', description: 'YYYY-MM-DD (لعملية date_diff)' },
        date_to: { type: 'string' }
      },
      required: ['operation']
    },
    async run(args) {
      const op = args.operation;
      const nums = (Array.isArray(args.numbers) ? args.numbers : []).map(Number).filter((n) => Number.isFinite(n));
      if (op === 'date_diff') {
        const a = new Date(args.date_from), b = new Date(args.date_to);
        if (isNaN(a) || isNaN(b)) return { ok: false, error: 'صيغة تاريخ غير صالحة (المطلوب YYYY-MM-DD)' };
        const days = Math.round((b - a) / 86400000);
        return { ok: true, operation: op, days, weeks: Math.round(days / 7 * 100) / 100, months: Math.round(days / 30.4375 * 100) / 100, years: Math.round(days / 365.25 * 1000) / 1000 };
      }
      if (!nums.length) return { ok: false, error: 'لا توجد أرقام صالحة' };
      const sum = nums.reduce((a, b) => a + b, 0);
      const sorted = [...nums].sort((a, b) => a - b);
      let value;
      switch (op) {
        case 'sum': value = sum; break;
        case 'avg': value = sum / nums.length; break;
        case 'median': value = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; break;
        case 'min': value = sorted[0]; break;
        case 'max': value = sorted[sorted.length - 1]; break;
        case 'count': value = nums.length; break;
        case 'percent': value = nums.length >= 2 ? (nums[0] / nums[1]) * 100 : NaN; break;
        case 'stdev': { const m = sum / nums.length; value = Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length); break; }
        default: return { ok: false, error: 'عملية غير مدعومة: ' + op };
      }
      return { ok: true, operation: op, count: nums.length, sum, value: Math.round(value * 10000) / 10000 };
    }
  });

  /* ═════════════════════ 6) مساعدات الملفات والتنزيل ═════════════════════ */

  function triggerDownload(blob, filename) {
    try {
      if (typeof window.saveAs === 'function') { window.saveAs(blob, filename); return; }
    } catch (e) { /* */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }

  /** منتقي ملف محلي — يُستخدم File System Access API إن توفّر وإلا input مخفي */
  function pickLocalFile() {
    return new Promise((resolve) => {
      if (typeof window.showOpenFilePicker === 'function') {
        window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'نصوص ومستندات',
            accept: {
              'text/plain': ['.txt', '.md', '.csv', '.json', '.log', '.xml'],
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
              'application/pdf': ['.pdf']
            }
          }]
        }).then(async (handles) => {
          if (!handles || !handles.length) return resolve(null);
          resolve(await handles[0].getFile());
        }).catch(() => resolve(null));
        return;
      }
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.txt,.md,.csv,.json,.log,.xml,.docx,.pdf';
      inp.style.display = 'none';
      inp.onchange = () => { const f = inp.files && inp.files[0]; remove(); resolve(f || null); };
      // إن أُلغيت النافذة لا يصل حدث — نُنظّف لاحقاً
      const remove = () => { try { inp.remove(); } catch (e) { /* */ } };
      document.body.appendChild(inp);
      inp.click();
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(() => { if (inp.isConnected && !(inp.files && inp.files.length)) { remove(); resolve(null); } }, 1200);
      }, { once: true });
    });
  }

  async function extractFileText(file) {
    const name = (file.name || '').toLowerCase();
    try {
      if (name.endsWith('.docx')) {
        const mammoth = window.mammoth || (typeof mammoth !== 'undefined' ? mammoth : null);
        if (!mammoth) return { ok: false, error: 'مكتبة mammoth غير محمّلة (تعذّر استخراج DOCX). افتح الموسوعة مع اتصال أولي لتحميلها، أو استخدم ملف نصي.' };
        const buf = await file.arrayBuffer();
        const out = await mammoth.extractRawText({ arrayBuffer: buf });
        return { ok: true, kind: 'docx', text: String(out && out.value || '') };
      }
      if (name.endsWith('.pdf')) {
        const lib = window.pdfjsLib;
        if (!lib) return { ok: false, error: 'محرك PDF المضمّن غير جاهز بعد. جرّب مرة أخرى بعد لحظات.' };
        const buf = await file.arrayBuffer();
        const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
        const total = Math.min(pdf.numPages, 40);
        let text = '';
        for (let i = 1; i <= total; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          text += tc.items.map((it) => it.str).join(' ') + '\n\n';
        }
        return { ok: true, kind: 'pdf', text: text, pages_read: total, pages_total: pdf.numPages };
      }
      return { ok: true, kind: 'text', text: await file.text() };
    } catch (e) {
      return { ok: false, error: 'تعذّر استخراج النص: ' + (e && e.message || e) };
    }
  }

  /* ═════════════════════ 7) تصدير للنطاق العام ═════════════════════ */
  window.__AI_AGENT = {
    CFG, TOOLS, TOOL_MAP, defineTool,
    loadCfg, saveCfg, assertLocalEndpoint, LS,
    norm, toEn, toAr, esc, tokens, buildBM25, makeSnippet,
    loadCatalog, getContent, getLegis, getLegisStatus, getPageMap,
    getDocsArray, triggerDownload, extractFileText, pickLocalFile,
    toolSchemas() {
      return TOOLS.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }
  };
})();
