/**
 * ═══════════════════════════════════════════════════════════════
 * NIABA UPLOAD WORKER v8 ULTRA
 * معالج رفع الملفات المتوازي - Web Worker
 * Parallel DOCX/DOC Processing + Smart Classification
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ─── استيراد مكتبة Mammoth لاستخراج النص من Word ───
self.importScripts('https://cdn.jsdelivr.net/npm/mammoth@1.4.2/mammoth.browser.min.js');

const AI_CLASSIFIER_VERSION = 8;

const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670]/g;
const ARABIC_ALEF = /[أإآا]/g;
const ARABIC_YA = /[يى]/g;
const ARABIC_TA = /[ةه]/g;

function normalizeText(t) {
    if (!t) return '';
    return t.replace(ARABIC_DIACRITICS,'').replace(ARABIC_ALEF,'ا')
            .replace(ARABIC_YA,'ي').replace(ARABIC_TA,'ه')
            .replace(/\s+/g,' ').trim().toLowerCase();
}

// ─── تصنيف الجريمة — مواءمة مع التصنيف الأصلي v7 ULTRA ───
const CRIME_TAXONOMY = [
    // جرائم الاعتداء على النفس
    {
        key: 'attempt-kill', label: 'شروع في قتل',
        group: 'جرائم الاعتداء على النفس',
        tags: ['شروع في قتل', 'شروع', 'قتل'],
        keywords: ['شروع في قتل','الشروع في القتل','محاولة قتل','شرع في ازهاق روح','لم يتم الجرم لسبب لا دخل لارادة الجاني فيه'],
        regexes: [/شروع.{0,12}قتل/, /محاول(?:ه|ة).{0,8}قتل/],
        minScore: 18
    },
    {
        key: 'premeditated-kill', label: 'قتل عمد',
        group: 'جرائم الاعتداء على النفس',
        tags: ['قتل عمد', 'قتل'],
        keywords: ['قتل عمد','جريمة القتل العمد','القصد الخاص','قصد القتل','نية القتل','ازهاق روح','سبق الاصرار','الترصد'],
        regexes: [/قتل.{0,8}عمد/, /(قصد|نيه).{0,8}القتل/, /سبق.{0,6}الاصرار/, /الترصد/],
        excludeAny: ['قتل خطا', 'القتل الخطا'],
        minScore: 18
    },
    {
        key: 'execution', label: 'الإعدام',
        group: 'جرائم الاعتداء على النفس',
        tags: ['إعدام', 'قتل'],
        keywords: ['الإعدام','عقوبة الإعدام','الحكم بالاعدام','رأي المفتي','إحالة الأوراق إلى المفتي'],
        regexes: [/عقوبه.{0,6}الاعدام/, /حكم.{0,6}بالاعدام/, /احاله.{0,12}المفتي/],
        minScore: 16
    },
    {
        key: 'assault', label: 'ضرب وجرح',
        group: 'جرائم الاعتداء على النفس',
        tags: ['ضرب', 'جرح', 'ضرب وجرح'],
        keywords: ['ضرب','جرح','التعدي بالضرب','إصابة المجني عليه'],
        regexes: [/تعد.{0,6}بالضرب/, /احداث.{0,6}اصابه/],
        minScore: 16
    },
    {
        key: 'permanent-disability', label: 'إحداث عاهة',
        group: 'جرائم الاعتداء على النفس',
        tags: ['عاهة', 'إحداث عاهة'],
        keywords: ['عاهة مستديمة','إحداث عاهة','فقد منفعة','قطع عضو','تشويه مستديم'],
        regexes: [/عاهه.{0,6}مستديم/, /احداث.{0,6}عاهه/],
        minScore: 16
    },
    // جرائم الأموال
    {
        key: 'theft', label: 'سرقة',
        group: 'جرائم الأموال',
        tags: ['سرقة'],
        keywords: ['سرقة','السرقة','سرقة بالإكراه','سرقة ليلاً','منقول مملوك للغير','كسر حرز'],
        regexes: [/سرق(?:ه|ة)/, /كسر.{0,6}حرز/],
        minScore: 16
    },
    {
        key: 'fraud', label: 'نصب واحتيال',
        group: 'جرائم الأموال',
        tags: ['نصب', 'نصب واحتيال'],
        keywords: ['نصب','احتيال','طرق احتيالية','الاستيلاء على مال الغير بطريق الاحتيال','الاستيلاء بطريق التدليس'],
        regexes: [/نصب/, /احتيال/, /طرق.{0,6}احتيالي/],
        minScore: 16
    },
    {
        key: 'damage', label: 'إتلاف عمد',
        group: 'جرائم الأموال',
        tags: ['إتلاف', 'إتلاف عمد'],
        keywords: ['إتلاف عمد','إتلاف','إحراق عمد','إتلاف منقول'],
        regexes: [/اتلاف.{0,6}عمد/, /احراق.{0,6}عمد/],
        minScore: 16
    },
    // جرائم الأموال العامة
    {
        key: 'embezzlement', label: 'اختلاس',
        group: 'جرائم الأموال العامة',
        tags: ['اختلاس', 'أموال عامة'],
        keywords: ['اختلاس','اختلاس مال عام','موظف عام','تسهيل الاستيلاء على مال عام','تبديد مال عام'],
        regexes: [/اختلاس/, /مال.{0,6}عام/, /موظف.{0,6}عام/],
        minScore: 18
    },
    {
        key: 'bribery', label: 'رشوة',
        group: 'جرائم الأموال العامة',
        tags: ['رشوة', 'أموال عامة'],
        keywords: ['رشوة','طلب عطية','قبول عطية','أخذ عطية','عمل من أعمال الوظيفة'],
        regexes: [/رشو(?:ه|ة)/, /طلب.{0,6}عطيه/, /قبول.{0,6}عطيه/],
        minScore: 18
    },
    {
        key: 'public-money', label: 'أموال عامة',
        group: 'جرائم الأموال العامة',
        tags: ['أموال عامة'],
        keywords: ['الاستيلاء على المال العام','العدوان على المال العام','إضرار عمدي بالمال العام','مال عام'],
        regexes: [/المال.{0,6}العام/, /عدوان.{0,6}المال.{0,6}العام/],
        minScore: 16
    },
    // الجرائم الاقتصادية
    {
        key: 'money-laundering', label: 'غسل أموال',
        group: 'الجرائم الاقتصادية',
        tags: ['غسل أموال', 'اقتصادية'],
        keywords: ['غسل الأموال','غسيل الأموال','إخفاء مصدر الأموال','تمويه الأموال','المتحصلات'],
        regexes: [/غس(?:ل|يل).{0,6}الاموال/, /اخفاء.{0,8}مصدر.{0,6}الاموال/],
        minScore: 16
    },
    {
        key: 'economic', label: 'جرائم اقتصادية',
        group: 'الجرائم الاقتصادية',
        tags: ['جرائم اقتصادية', 'اقتصادية'],
        keywords: ['جريمة اقتصادية','الاقتصاد القومي','تهرب ضريبي','تهريب جمركي','نقد أجنبي','اتجار بالنقد','مخالفة تموينية','غش تجاري'],
        regexes: [/تهرب.{0,6}ضريب/, /تهريب.{0,6}جمرك/, /نقد.{0,6}اجنب/, /مخالف.{0,6}تموين/],
        minScore: 16
    },
    // جرائم المخدرات
    {
        key: 'drugs', label: 'مخدرات',
        group: 'جرائم المخدرات',
        tags: ['مخدرات'],
        keywords: ['مخدرات','جوهر مخدر','حشيش','هيروين','ترامادول','اتجار في المخدرات','إحراز جوهر مخدر'],
        regexes: [/جوهر.{0,6}مخدر/, /اتجار.{0,6}مخدر/, /احراز.{0,6}مخدر/],
        minScore: 16
    },
    // جرائم المستندات
    {
        key: 'forgery', label: 'تزوير',
        group: 'جرائم المستندات',
        tags: ['تزوير'],
        keywords: ['تزوير','محرر مزور','استعمال محرر مزور','اصطناع','تقليد خاتم','محرر رسمي','محرر عرفي'],
        regexes: [/تزوير/, /محرر.{0,6}مزور/, /استعمال.{0,8}محرر.{0,6}مزور/],
        minScore: 16
    },
    // جرائم العرض
    {
        key: 'sexual-assault', label: 'اغتصاب وهتك عرض',
        group: 'جرائم العرض',
        tags: ['اغتصاب', 'هتك عرض'],
        keywords: ['اغتصاب','هتك عرض','مواقعة','هتك عرض بالقوة'],
        regexes: [/اغتصاب/, /هتك.{0,6}عرض/, /مواقع(?:ه|ة)/],
        minScore: 16
    },
    // جرائم الحرية
    {
        key: 'kidnapping', label: 'خطف',
        group: 'جرائم الحرية',
        tags: ['خطف'],
        keywords: ['خطف','اختطاف','إبعاد المجني عليه','حجزه بدون وجه حق'],
        regexes: [/خطف/, /اختطاف/],
        minScore: 16
    },
    // إضافات مفيدة
    {
        key: 'weapons', label: 'أسلحة وذخائر',
        group: 'جرائم الأسلحة',
        tags: ['أسلحة', 'ذخائر'],
        keywords: ['أسلحة نارية','ذخائر','إحراز سلاح','حيازة سلاح بدون ترخيص'],
        regexes: [/احراز.{0,6}سلاح/, /حيازة.{0,6}سلاح/, /ذخائر/],
        minScore: 16
    },
    {
        key: 'defamation', label: 'قذف وسب',
        group: 'جرائم الشرف',
        tags: ['قذف', 'سب', 'قذف وسب'],
        keywords: ['قذف','سب','إهانة','سب الذات العلية','انتهاك الحرمة'],
        regexes: [/قذف/, /سب.{0,6}وقذف/, /إهانه.{0,6}الموظف/],
        minScore: 14
    }
];

// Normalize taxonomy
CRIME_TAXONOMY.forEach(rule => {
    rule._keywords = rule.keywords.map(k => normalizeText(k));
    rule._regexes = rule.regexes || [];
    rule._tags = rule.tags || [rule.label];
    rule._excludeAny = (rule.excludeAny || []).map(k => normalizeText(k));
});

function classifyAppeal(fileName, content) {
    const nameNorm = normalizeText(fileName || '');
    const contentNorm = normalizeText((content || '').slice(0, 100000));
    const textNorm = `${nameNorm} ${contentNorm}`;
    const matches = [];

    for (const rule of CRIME_TAXONOMY) {
        // Check exclusions first
        if (rule._excludeAny && rule._excludeAny.length > 0) {
            if (rule._excludeAny.some(ex => textNorm.includes(ex))) continue;
        }
        let score = 0;
        for (const kw of rule._keywords) {
            if (!kw) continue;
            if (nameNorm.includes(kw)) score += kw.includes(' ') ? 28 : 16;
            else if (textNorm.includes(kw)) score += kw.includes(' ') ? 12 : 6;
        }
        for (const rx of rule._regexes) {
            try {
                if (rx.test(nameNorm)) score += 30;
                else if (rx.test(textNorm)) score += 14;
            } catch(e) {}
        }
        if (score >= (rule.minScore || 14)) matches.push({ rule, score });
    }

    matches.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const item of matches) {
        if (!selected.some(x => x.rule.label === item.rule.label)) selected.push(item);
        if (selected.length >= 5) break;
    }

    const crimeLabels = [...new Set(selected.map(m => m.rule.label))];
    const crimeTags = [...new Set(selected.flatMap(m => m.rule._tags || [m.rule.label]))];
    const virtualFolders = selected.map(m => {
        const bucket = '📂 موسوعة قانونية';
        const group = m.rule.group || '';
        const label = m.rule.label;
        return [bucket, group, label].filter(Boolean).join('/');
    });

    return {
        crimeType: crimeLabels[0] || 'غير محدد',
        crimeLabels, crimeTags,
        virtualFolders: [...new Set(virtualFolders)],
        aiConfidence: selected[0] ? Math.min(99, 40 + selected[0].score) : 0,
        autoClassifierVersion: AI_CLASSIFIER_VERSION
    };
}

function buildAutoSummary(content, docType, crimeLabels) {
    if (!content || content.length < 40) return '';
    const chunks = content
        .replace(/\r/g, '\n')
        .split(/\n{2,}|\n|[\.؟!؛]/)
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(s => s.length >= 25 && s.length <= 260);
    if (!chunks.length) return content.replace(/\s+/g, ' ').trim().slice(0, 380);

    const labelTerms = (crimeLabels || []).flatMap(l => normalizeText(l).split(/\s+/));
    const ranked = chunks.map(chunk => {
        const norm = normalizeText(chunk);
        let score = 0;
        if (docType === 'مذكرة' && (norm.includes('ينعى') || norm.includes('الطاعن'))) score += 8;
        if (norm.includes('حيث') || norm.includes('الثابت')) score += 4;
        labelTerms.forEach(t => { if (t && norm.includes(t)) score += 5; });
        if (chunk.length >= 60 && chunk.length <= 180) score += 3;
        return { chunk, score };
    }).sort((a, b) => b.score - a.score);

    const picked = [];
    for (const item of ranked) {
        if (picked.length >= 2) break;
        if (!picked.some(p => normalizeText(p).includes(normalizeText(item.chunk)))) {
            picked.push(item.chunk);
        }
    }
    const summary = (picked.length ? picked : ranked.slice(0, 1).map(r => r.chunk)).join(' — ').trim();
    return summary.length > 380 ? summary.slice(0, 377) + '...' : summary;
}

async function extractDocxText(arrayBuffer) {
    try {
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value || '';
    } catch(e) {
        return '';
    }
}

function detectDocType(fileName, content) {
    const combined = (fileName + ' ' + (content || '')).toLowerCase();
    if (combined.includes('مذكرة') || combined.includes('دفاع') || combined.includes('طاعن')) {
        return 'مذكرة';
    }
    return 'حكم';
}

function extractAppealNumber(fileName) {
    const m = fileName.match(/(\d{3,6})/);
    return m ? m[1] : '';
}

// ─── Process a single file ───
async function processFile(fileData, mode) {
    const { name, arrayBuffer, folder, isFolder, folderPath } = fileData;
    const ext = name.split('.').pop().toLowerCase();

    if (!['docx', 'doc'].includes(ext)) return null;

    let content = '';
    if (mode === 'normal' || mode === undefined) {
        content = await extractDocxText(arrayBuffer);
    }

    const docType = detectDocType(name, content);
    const appealNumber = extractAppealNumber(name);
    const classification = classifyAppeal(name, content);
    const autoSummary = buildAutoSummary(content, docType, classification.crimeLabels);
    const folderName = isFolder
        ? (folderPath ? folderPath.split('/').slice(0, -1).join('/') || 'عام' : 'عام')
        : 'عام';
    const fileMime = ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/msword';
    const fileBlob = new Blob([arrayBuffer], { type: fileMime });

    return {
        fileName: name,
        folder: folderName,
        fileType: 'word',
        docType,
        crimeType: classification.crimeType,
        crimeLabels: classification.crimeLabels,
        crimeTags: classification.crimeTags,
        virtualFolders: classification.virtualFolders,
        appealNumber,
        content,
        isIndexed: content.length > 10 ? 1 : 0,
        uploadDate: Date.now(),
        autoSummary,
        aiConfidence: classification.aiConfidence,
        autoClassifierVersion: AI_CLASSIFIER_VERSION,
        fileBlob,
        fileBase64: null,
        fileMime,
        folderPaths: [folderName, ...classification.virtualFolders].filter((v,i,a) => v && a.indexOf(v) === i)
    };
}

// ─── Message Handler ───
self.onmessage = async function(e) {
    const { type, payload, reqId } = e.data;

    if (type === 'PROCESS_FILE') {
        try {
            const result = await processFile(payload.file, payload.mode);
            self.postMessage({ type: 'FILE_PROCESSED', reqId,
                payload: { result, index: payload.index, total: payload.total }
            });
        } catch(err) {
            self.postMessage({ type: 'FILE_ERROR', reqId,
                payload: { error: err.message, index: payload.index, fileName: payload.file.name }
            });
        }
    } else if (type === 'PROCESS_BATCH') {
        const { files, mode, batchIndex } = payload;
        const results = [];
        for (let i = 0; i < files.length; i++) {
            try {
                const res = await processFile(files[i], mode);
                if (res) results.push(res);
            } catch(e) {}
            if (i % 3 === 0) {
                self.postMessage({ type: 'BATCH_PROGRESS', reqId,
                    payload: { batchIndex, done: i + 1, total: files.length }
                });
            }
        }
        self.postMessage({ type: 'BATCH_DONE', reqId,
            payload: { results, batchIndex, count: results.length }
        });
    }
};
