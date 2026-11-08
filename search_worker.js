/**
 * ═══════════════════════════════════════════════════════════════════
 * NIABA SEARCH WORKER v8 ULTRA
 * محرك البحث المتقدم - Web Worker
 * BM25 + TF-IDF + Fuzzy + Arabic NLP + Inverted Index
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

// ─── الثوابت ───
const BM25_K1 = 1.5;
const BM25_B  = 0.75;
const MAX_RESULTS = 2000;
const SNIPPET_LEN = 350;
const FUZZY_THRESHOLD = 0.72;

// ─── حالة الفهرس ───
let _invertedIndex = null;   // Map<token, Map<docId, {tf, positions}>>
let _documents     = [];     // مصفوفة السجلات الوصفية (بدون محتوى)
let _docsById      = new Map(); // نفس بيانات _documents لكن بمفتاح docId لبحث O(1) بدل O(n)
let _docCount      = 0;
let _avgDocLen     = 0;
let _docLens       = new Map();   // docId -> term count
let _dfMap         = new Map();   // term -> document frequency
let _idfCache      = new Map();   // term -> idf value
let _ready         = false;
let _ngramIndex    = null;   // Map<bigram, Set<docId>> للبحث الضبابي
let _synonymMap    = null;   // Map<word, synonyms[]>

// ─── عَرَبية ───
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670]/g;
const ARABIC_ALEF_VARIANTS = /[أإآا]/g;
const ARABIC_YA_VARIANTS   = /[يى]/g;
const ARABIC_TA_MARBUTA    = /[ةه]/g;
const ARABIC_WAWA          = /[وؤ]/g;
const ARABIC_PUNCT         = /[،؛؟!.,:;()\[\]{}"'«»\-_\/\\|@#$%^&*+=~`]/g;
const STOP_WORDS = new Set([
    'في','من','إلى','على','عن','مع','هو','هي','هم','هن','أن','إن','كان','كانت',
    'أو','و','ف','ب','ل','لا','لم','لن','قد','قال','يكون','التي','الذي','الذين',
    'اللاتي','اللواتي','هذا','هذه','ذلك','تلك','هؤلاء','أولئك','ما','لما','مما',
    'عند','عندما','حين','حيث','إذا','إذ','بعد','قبل','خلال','حتى','منذ','رغم',
    'بسبب','بموجب','وفقا','طبقا','وفق','طبق','يكن','تكن','كل','جميع','بعض',
    'أحد','إحدى','أي','أية','غير','سوى','فقط','أيضا','كذلك','لذلك','لهذا',
    'المحكمة','محكمة','الحكم','حكم','المذكرة','نيابة','النقض','الطاعن','الطاعنة',
    'المطعون','ضده','ضدها','القضية','الدعوى','الطعن'
]);

function normalizeArabic(text) {
    if (!text) return '';
    return text
        .replace(ARABIC_DIACRITICS, '')
        .replace(ARABIC_ALEF_VARIANTS, 'ا')
        .replace(ARABIC_YA_VARIANTS, 'ي')
        .replace(ARABIC_TA_MARBUTA, 'ه')
        .replace(ARABIC_WAWA, 'و')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function tokenize(text, removeStops = true) {
    if (!text) return [];
    const norm = normalizeArabic(text);
    const tokens = norm.replace(ARABIC_PUNCT, ' ').split(/\s+/).filter(t => t.length >= 2);
    if (removeStops) return tokens.filter(t => !STOP_WORDS.has(t));
    return tokens;
}

// ─── N-Gram Builder للبحث الضبابي ───
function buildBigrams(word) {
    const bigrams = [];
    if (word.length < 2) return bigrams;
    for (let i = 0; i < word.length - 1; i++) {
        bigrams.push(word.slice(i, i + 2));
    }
    return bigrams;
}

function buildNgramIndex(invertedIndex) {
    const ngIdx = new Map();
    for (const [token, postings] of invertedIndex) {
        const bigrams = buildBigrams(token);
        for (const bg of bigrams) {
            if (!ngIdx.has(bg)) ngIdx.set(bg, new Set());
            for (const [docId] of postings) {
                ngIdx.get(bg).add(docId);
            }
        }
    }
    return ngIdx;
}

// ─── Levenshtein Distance ───
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = [];
    for (let i = 0; i <= m; i++) dp[i] = [i];
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i-1] === b[j-1]) dp[i][j] = dp[i-1][j-1];
            else dp[i][j] = 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
        }
    }
    return dp[m][n];
}

function jaccardSim(bigrams1, bigrams2Set) {
    if (!bigrams1.length || !bigrams2Set.size) return 0;
    let intersection = 0;
    for (const bg of bigrams1) {
        if (bigrams2Set.has(bg)) intersection++;
    }
    return intersection / (bigrams1.length + bigrams2Set.size - intersection);
}

// ─── IDF Calculator ───
function idf(term) {
    if (_idfCache.has(term)) return _idfCache.get(term);
    const df = _dfMap.get(term) || 0;
    const val = df > 0 ? Math.log(1 + (_docCount - df + 0.5) / (df + 0.5)) : 0;
    _idfCache.set(term, val);
    return val;
}

// ─── BM25 Score ───
function bm25Score(docId, terms) {
    if (!_invertedIndex) return 0;
    const docLen = _docLens.get(docId) || 1;
    let score = 0;
    for (const term of terms) {
        const postings = _invertedIndex.get(term);
        if (!postings || !postings.has(docId)) continue;
        const tf = postings.get(docId).tf || 0;
        const idfVal = idf(term);
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / _avgDocLen);
        score += idfVal * (numerator / denominator);
    }
    return score;
}

// ─── بناء الفهرس المعكوس ───
function buildIndex(records) {
    const inv = new Map();
    const docLens = new Map();
    const dfMap = new Map();
    let totalLen = 0;

    for (const rec of records) {
        const tokens = tokenize(rec._searchText || '');
        docLens.set(rec.id, tokens.length);
        totalLen += tokens.length;

        const tfMap = new Map();
        const posMap = new Map();
        tokens.forEach((t, pos) => {
            tfMap.set(t, (tfMap.get(t) || 0) + 1);
            if (!posMap.has(t)) posMap.set(t, []);
            posMap.get(t).push(pos);
        });

        const seenTerms = new Set();
        for (const [term, tf] of tfMap) {
            if (!inv.has(term)) inv.set(term, new Map());
            inv.get(term).set(rec.id, { tf, positions: posMap.get(term) });
            if (!seenTerms.has(term)) {
                dfMap.set(term, (dfMap.get(term) || 0) + 1);
                seenTerms.add(term);
            }
        }
    }

    return { inv, docLens, dfMap, avgLen: records.length > 0 ? totalLen / records.length : 1 };
}

// ─── Fuzzy Token Expansion ───
function fuzzyExpandTokens(queryTokens, maxExpand = 5) {
    if (!_invertedIndex || !_ngramIndex) return queryTokens;
    const expanded = [...queryTokens];
    const allTerms = [..._invertedIndex.keys()];

    for (const qt of queryTokens) {
        if (qt.length < 3) continue;
        const qtBigrams = buildBigrams(qt);
        const qtBigramSet = new Set(qtBigrams);

        // Find candidate terms via ngram index
        const candidates = new Set();
        for (const bg of qtBigrams) {
            const docSet = _ngramIndex.get(bg);
            if (docSet) {
                // Use the bigram to find matching terms
                for (const term of allTerms) {
                    if (Math.abs(term.length - qt.length) <= 3) candidates.add(term);
                }
                break; // Limit
            }
        }

        // Score candidates
        let added = 0;
        for (const cand of candidates) {
            if (cand === qt || expanded.includes(cand)) continue;
            const sim = jaccardSim(qtBigrams, new Set(buildBigrams(cand)));
            if (sim >= FUZZY_THRESHOLD) {
                expanded.push(cand);
                if (++added >= maxExpand) break;
            }
        }
    }
    return [...new Set(expanded)];
}

// ─── Arabic Synonyms ───
function buildSynonymMap() {
    const synonyms = {
        'جريمة': ['جرم', 'جرائم', 'فعل إجرامي'],
        'حكم': ['قضاء', 'قرار', 'منطوق'],
        'طعن': ['استئناف', 'نقض', 'تظلم'],
        'قتل': ['اغتيال', 'إزهاق الروح'],
        'سرقة': ['نشل', 'اختلاس', 'سلب'],
        'تزوير': ['تزييف', 'تحريف', 'اصطناع'],
        'إثبات': ['دليل', 'شاهد', 'بينة', 'إقرار'],
        'براءة': ['تبرئة', 'إخلاء السبيل'],
        'إدانة': ['ثبوت', 'تجريم'],
        'مبدأ': ['قاعدة', 'نص', 'حكم مستقر'],
        'دفاع': ['محامي', 'محامٍ', 'وكيل'],
        'متهم': ['طاعن', 'مدعى عليه', 'مقبوض عليه'],
        'شاهد': ['مخبر', 'راوٍ', 'من رأى'],
        'عقوبة': ['جزاء', 'حبس', 'سجن', 'غرامة'],
        'محكمة': ['هيئة قضائية', 'مجلس القضاء'],
    };
    const map = new Map();
    for (const [word, syns] of Object.entries(synonyms)) {
        const normWord = normalizeArabic(word);
        map.set(normWord, syns.map(normalizeArabic));
        // Reverse mapping
        for (const s of syns) {
            const ns = normalizeArabic(s);
            if (!map.has(ns)) map.set(ns, []);
            if (!map.get(ns).includes(normWord)) map.get(ns).push(normWord);
        }
    }
    return map;
}

function expandWithSynonyms(tokens) {
    if (!_synonymMap) return tokens;
    const expanded = [...tokens];
    for (const token of tokens) {
        const syns = _synonymMap.get(token);
        if (syns) {
            for (const s of syns) {
                if (!expanded.includes(s)) expanded.push(s);
            }
        }
    }
    return expanded;
}

// ─── Snippet Generator ───
function generateSnippet(text, queryTerms, maxLen = SNIPPET_LEN) {
    if (!text || !queryTerms.length) return text ? text.slice(0, maxLen) : '';
    const normText = normalizeArabic(text);
    const normTerms = queryTerms.map(normalizeArabic);

    // Find best window
    let bestPos = 0, bestScore = -1;
    for (let i = 0; i < normText.length - 50; i++) {
        let score = 0;
        for (const t of normTerms) {
            if (normText.indexOf(t, i) - i < 200) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestPos = i;
        }
        i += 50; // Step
    }

    const start = Math.max(0, bestPos - 50);
    let snippet = text.slice(start, start + maxLen);
    if (start > 0) snippet = '...' + snippet;
    if (start + maxLen < text.length) snippet += '...';
    return snippet;
}

// ─── Phrase Search (Exact) ───
function phraseSearch(phrase, docId) {
    if (!_invertedIndex) return false;
    const terms = tokenize(phrase, false);
    if (!terms.length) return false;
    if (terms.length === 1) {
        const postings = _invertedIndex.get(terms[0]);
        return postings ? postings.has(docId) : false;
    }

    // Check consecutive positions
    const postings0 = _invertedIndex.get(terms[0]);
    if (!postings0 || !postings0.has(docId)) return false;
    const positions0 = postings0.get(docId).positions || [];

    for (const startPos of positions0) {
        let match = true;
        for (let i = 1; i < terms.length; i++) {
            const pi = _invertedIndex.get(terms[i]);
            if (!pi || !pi.has(docId)) { match = false; break; }
            const positions_i = pi.get(docId).positions || [];
            if (!positions_i.includes(startPos + i)) { match = false; break; }
        }
        if (match) return true;
    }
    return false;
}

// ─── Main Search Function ───
function search(params) {
    if (!_ready || !_invertedIndex) {
        return { results: [], total: 0, time: 0, error: 'Index not ready' };
    }

    const t0 = performance.now();
    const {
        exact = '', extra = '', exclude = '',
        logic = 'AND', docType = 'all', fileType = 'all',
        crimeType = 'all', minRel = 0, article = '',
        apNum = '', apYear = '', fuzzy = false,
        synonymExpand = true, selectedFolders = [],
        limit = 50, offset = 0
    } = params;

    if (!exact && !extra && !article && !apNum && docType === 'all' && crimeType === 'all') {
        return { results: [], total: 0, time: 0, error: 'empty_query' };
    }

    // Build query tokens
    let exactTokens = exact ? tokenize(exact, false) : [];
    let extraTokens = extra ? tokenize(extra) : [];
    if (synonymExpand && exactTokens.length) exactTokens = expandWithSynonyms(exactTokens);
    if (synonymExpand && extraTokens.length) extraTokens = expandWithSynonyms(extraTokens);
    if (fuzzy && exactTokens.length) exactTokens = fuzzyExpandTokens(exactTokens);
    if (fuzzy && extraTokens.length) extraTokens = fuzzyExpandTokens(extraTokens);

    const excludeTokens = exclude ? tokenize(exclude) : [];
    const allQueryTokens = [...new Set([...exactTokens, ...extraTokens])];

    // Candidate retrieval via inverted index
    let candidateIds = null;

    if (exactTokens.length > 0) {
        if (logic === 'AND') {
            // Intersection
            for (const term of exactTokens) {
                const postings = _invertedIndex.get(term);
                if (!postings) { candidateIds = new Set(); break; }
                const docSet = new Set(postings.keys());
                if (candidateIds === null) candidateIds = docSet;
                else {
                    for (const id of candidateIds) {
                        if (!docSet.has(id)) candidateIds.delete(id);
                    }
                }
            }
        } else {
            // OR — Union
            candidateIds = new Set();
            for (const term of exactTokens) {
                const postings = _invertedIndex.get(term);
                if (postings) {
                    for (const id of postings.keys()) candidateIds.add(id);
                }
            }
        }
    }

    if (extraTokens.length > 0 && candidateIds === null) {
        candidateIds = new Set();
        for (const term of extraTokens) {
            const postings = _invertedIndex.get(term);
            if (postings) {
                for (const id of postings.keys()) candidateIds.add(id);
            }
        }
    }

    // Appeal number filter
    let apNumSet = null;
    if (apNum || apYear) {
        apNumSet = new Set();
        for (const doc of _documents) {
            const numMatch = !apNum || (doc.appealNumber || '').includes(apNum);
            const yearMatch = !apYear || (doc.uploadDate ? new Date(doc.uploadDate).getFullYear().toString() === apYear : false);
            if (numMatch && yearMatch) apNumSet.add(doc.id);
        }
    }

    // Determine candidate set
    let workSet;
    if (candidateIds !== null && apNumSet !== null) {
        workSet = new Set([...candidateIds].filter(id => apNumSet.has(id)));
    } else if (candidateIds !== null) {
        workSet = candidateIds;
    } else if (apNumSet !== null) {
        workSet = apNumSet;
    } else {
        workSet = new Set(_documents.map(d => d.id));
    }

    // Score and filter
    const scored = [];
    for (const docId of workSet) {
        const doc = _docsById.get(docId);
        if (!doc) continue;

        // Metadata filters
        if (docType !== 'all' && doc.docType !== docType) continue;
        if (fileType !== 'all' && doc.fileType !== fileType) continue;
        if (crimeType !== 'all') {
            const labels = doc.crimeLabels || [];
            const ct = normalizeArabic(crimeType);
            if (!labels.some(l => normalizeArabic(l).includes(ct)) && normalizeArabic(doc.crimeType || '').indexOf(ct) === -1) continue;
        }
        if (selectedFolders.length > 0) {
            const fps = doc.folderPaths || [doc.folder || 'عام'];
            if (!fps.some(fp => selectedFolders.includes(fp))) continue;
        }

        // Exclude filter
        if (excludeTokens.length > 0) {
            const norm = normalizeArabic(doc._searchText || doc.fileName || '');
            if (excludeTokens.some(et => norm.includes(et))) continue;
        }

        // Exact phrase check (if multi-word)
        if (exact && exact.includes(' ')) {
            if (!phraseSearch(exact, docId)) continue;
        }

        // BM25 score
        let score = bm25Score(docId, allQueryTokens);

        // Article boost
        if (article) {
            const normArt = normalizeArabic(article);
            const norm = normalizeArabic(doc._searchText || doc.fileName || '');
            if (norm.includes(normArt)) score += 8;
        }

        // Min relevance filter
        if (score < minRel) continue;

        scored.push({ id: docId, score, doc });
    }

    // Sort by BM25 score desc
    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const pageResults = scored.slice(offset, offset + limit);

    const t1 = performance.now();
    return {
        results: pageResults.map(({ id, score, doc }) => ({
            id, score: Math.round(score * 10) / 10,
            fileName: doc.fileName, folder: doc.folder,
            docType: doc.docType, fileType: doc.fileType,
            crimeType: doc.crimeType, crimeLabels: doc.crimeLabels || [],
            uploadDate: doc.uploadDate, appealNumber: doc.appealNumber,
            autoSummary: doc.autoSummary || '',
            folderPaths: doc.folderPaths || [doc.folder || 'عام'],
            notes: doc.notes || ''
        })),
        total,
        time: Math.round(t1 - t0),
        queryTokens: allQueryTokens
    };
}

// ─── Quick Search (Autocomplete) ───
function quickSearch(query, limit = 20) {
    if (!_ready || !_invertedIndex || !query || query.length < 2) return [];
    const norm = normalizeArabic(query);
    const results = [];
    const seen = new Set();

    for (const doc of _documents) {
        if (results.length >= limit) break;
        const nameNorm = normalizeArabic(doc.fileName);
        if (nameNorm.includes(norm) && !seen.has(doc.id)) {
            seen.add(doc.id);
            results.push({
                id: doc.id, fileName: doc.fileName,
                folder: doc.folder, docType: doc.docType,
                crimeType: doc.crimeType
            });
        }
    }
    return results;
}

// ─── Message Handler ───
self.onmessage = function(e) {
    const { type, payload, reqId } = e.data;

    try {
        switch (type) {
            case 'BUILD_INDEX': {
                const { records } = payload;
                _documents = records;
                _docsById = new Map();
                for (const rec of records) _docsById.set(rec.id, rec);
                _docCount = records.length;
                if (_docCount > 0) {
                    const { inv, docLens, dfMap, avgLen } = buildIndex(records);
                    _invertedIndex = inv;
                    _docLens = docLens;
                    _dfMap = dfMap;
                    _avgDocLen = avgLen;
                    _idfCache.clear();
                    _ngramIndex = buildNgramIndex(inv);
                    _synonymMap = buildSynonymMap();
                    _ready = true;
                }
                self.postMessage({ type: 'INDEX_READY', reqId,
                    payload: { docCount: _docCount, termCount: _invertedIndex ? _invertedIndex.size : 0 }
                });
                break;
            }

            case 'ADD_DOCS': {
                const { records: newRecs } = payload;
                if (!newRecs.length) break;
                _documents.push(...newRecs);
                for (const rec of newRecs) _docsById.set(rec.id, rec);
                _docCount = _documents.length;
                // Incremental index update
                const { inv, docLens, dfMap, avgLen } = buildIndex(newRecs);
                // Merge
                for (const [term, postings] of inv) {
                    if (!_invertedIndex.has(term)) _invertedIndex.set(term, new Map());
                    for (const [docId, data] of postings) {
                        _invertedIndex.get(term).set(docId, data);
                    }
                }
                for (const [id, len] of docLens) _docLens.set(id, len);
                for (const [term, df] of dfMap) _dfMap.set(term, (_dfMap.get(term) || 0) + df);
                const totalLen = [..._docLens.values()].reduce((a, b) => a + b, 0);
                _avgDocLen = totalLen / _docCount;
                _idfCache.clear();
                _ngramIndex = buildNgramIndex(_invertedIndex);
                _ready = true;
                self.postMessage({ type: 'INDEX_UPDATED', reqId,
                    payload: { docCount: _docCount, added: newRecs.length }
                });
                break;
            }

            case 'SEARCH': {
                const result = search(payload);
                self.postMessage({ type: 'SEARCH_RESULT', reqId, payload: result });
                break;
            }

            case 'QUICK_SEARCH': {
                const results = quickSearch(payload.query, payload.limit);
                self.postMessage({ type: 'QUICK_RESULT', reqId, payload: { results } });
                break;
            }

            case 'GET_STATS': {
                self.postMessage({ type: 'STATS', reqId, payload: {
                    ready: _ready,
                    docCount: _docCount,
                    termCount: _invertedIndex ? _invertedIndex.size : 0,
                    avgDocLen: Math.round(_avgDocLen)
                }});
                break;
            }

            case 'CLEAR': {
                _invertedIndex = null;
                _documents = [];
                _docsById = new Map();
                _docCount = 0;
                _avgDocLen = 0;
                _docLens = new Map();
                _dfMap = new Map();
                _idfCache = new Map();
                _ngramIndex = null;
                _ready = false;
                self.postMessage({ type: 'CLEARED', reqId });
                break;
            }
        }
    } catch(err) {
        self.postMessage({ type: 'ERROR', reqId, payload: { message: err.message, stack: err.stack } });
    }
};
