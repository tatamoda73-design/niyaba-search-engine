/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANTI-DUPLICATE FIX v1.0 — حل جذري ونهائي لمشكلة تضاعف السجلات
 * ───────────────────────────────────────────────────────────────────────────
 * المشكلة الجذرية (3 مصادر):
 *
 * [1] portable-engine.injectPortableDB() يُشغَّل في كل فتح للصفحة:
 *     — شرط الحماية يعتمد على db.metadata غير الموجود في schema الأصلي
 *     — فيمسح DB بالكامل (clear) ثم يُعيد الحقن → إصابة بالتكرار
 *     — عند الحقن يستخدم bulkPut بدلاً من bulkAdd مما يُضاعف بدلاً من التجديد
 *
 * [2] PORTABLE-LOADER (داخل index.html) يستدعي loadEssentialData() بعد
 *     تحميل db-data.js (tryMergeWhenReady)، ثم portable-engine يستدعيها
 *     مرة أخرى بعد الحقن — والدالة تدمج window.ENCYCLOPEDIA_DB في كل مرة.
 *
 * [3] loadEssentialData نفسها تبدأ بـ allAppeals = [] وتُعيد بناء الدمج
 *     من ENCYCLOPEDIA_DB في كل استدعاء → لو استُدعيت 3 مرات تظهر السجلات
 *     3 مرات في الذاكرة وتُكتب 3 مرات في IndexedDB عند أي حفظ لاحق.
 *
 * الحل:
 * ─────
 * [A] مفتاح sessionStorage "db_data_injected" يضمن أن حقن db-data.js في
 *     IndexedDB لا يحدث إلا مرة واحدة في كل جلسة متصفح.
 *
 * [B] تسجيل checksum (عدد السجلات + إصدار) في localStorage لمنع إعادة
 *     الحقن في الجلسات التالية ما لم يتغير db-data.js.
 *
 * [C] اعتراض injectPortableDB وتطبيق UPSERT الذكي:
 *     — لا clear() إطلاقاً
 *     — تحقق بالمفتاح (folder||fileName) قبل أي إضافة
 *     — bulkAdd للجديد فقط
 *
 * [D] اعتراض loadEssentialData وتطبيق حماية الدمج:
 *     — window.ENCYCLOPEDIA_DB يُدمج في allAppeals مرة واحدة بالجلسة
 *     — خزّن الـ IDs المُعطاة لسجلات db-data.js لمنع إعادة الدمج
 *
 * [E] عند الإطلاق: تنظيف فوري للتكرارات الموجودة مسبقاً في IndexedDB
 *     مع الاحتفاظ بأفضل نسخة (الأطول محتوى / الأكثر بيانات).
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    var TAG = '[ANTI-DUP-FIX]';
    var SESSION_INJECTED_KEY = 'pe_session_injected_v1';
    var LS_CHECKSUM_KEY      = 'pe_db_checksum_v1';
    var _earlyTrapInstalled  = false;

    // ─── مساعدات ───────────────────────────────────────────────────────────

    function log(msg) {
        console.log(TAG + ' ' + msg);
    }

    function warn(msg) {
        console.warn(TAG + ' ' + msg);
    }

    /** مفتاح التطبيع الموحّد (folder||fileName) — متوافق مع PE_normKey */
    function normKey(folder, fileName) {
        var f = String(folder || 'عام')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .trim() || 'عام';
        var n = String(fileName || '')
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            .trim();
        // تطبيع بسيط للمقارنة
        f = f.replace(/[\u0622\u0623\u0625\u0627\u0671]/g, 'ا')
             .replace(/[ةه]/g, 'ه')
             .replace(/[يى]/g, 'ي')
             .replace(/[\u064B-\u065F]/g, '')
             .replace(/\s+/g, ' ')
             .trim()
             .toLowerCase();
        n = n.replace(/[\u0622\u0623\u0625\u0627\u0671]/g, 'ا')
             .replace(/[ةه]/g, 'ه')
             .replace(/[يى]/g, 'ي')
             .replace(/[\u064B-\u065F]/g, '')
             .replace(/\s+/g, ' ')
             .trim()
             .toLowerCase();
        return f + '||' + n;
    }

    /** حساب checksum لـ db-data.js */
    function calcEncyclopediaChecksum() {
        var pkg = window.ENCYCLOPEDIA_DB;
        if (!pkg || !Array.isArray(pkg.appeals)) return null;
        return 'v' + (pkg.version || 1) + '_n' + pkg.appeals.length;
    }

    /** هل تم الحقن في هذه الجلسة بالفعل؟ */
    function isAlreadyInjectedThisSession() {
        var cs = calcEncyclopediaChecksum();
        if (!cs) return false;
        return sessionStorage.getItem(SESSION_INJECTED_KEY) === cs;
    }

    /** هل تم الحقن في الجلسات السابقة وما زالت البيانات سليمة؟ */
    async function isAlreadyInjectedPersistent() {
        var cs = calcEncyclopediaChecksum();
        if (!cs) return false;
        var stored = localStorage.getItem(LS_CHECKSUM_KEY);
        if (stored !== cs) return false;
        // تحقق أيضاً من أن عدد السجلات في DB معقول
        var db = window.db;
        if (!db || !db.appeals) return false;
        var count = await db.appeals.count().catch(function () { return 0; });
        var pkg = window.ENCYCLOPEDIA_DB;
        return count >= Math.floor(pkg.appeals.length * 0.85);
    }

    /** تسجيل أن الحقن تم بنجاح */
    function markInjectionDone() {
        var cs = calcEncyclopediaChecksum();
        if (!cs) return;
        sessionStorage.setItem(SESSION_INJECTED_KEY, cs);
        localStorage.setItem(LS_CHECKSUM_KEY, cs);
        log('✅ تم تسجيل علامة الحقن — ' + cs);
    }

    // ─── [E] تنظيف التكرارات الموجودة مسبقاً في IndexedDB ─────────────────

    async function cleanupExistingDuplicates(db) {
        if (!db || !db.appeals) return;
        var total = await db.appeals.count().catch(function () { return 0; });
        if (total === 0) return;

        log('🔍 فحص التكرارات في ' + total.toLocaleString('ar-EG') + ' سجل...');

        var best = new Map(); // key → {id, score}
        var toDelete = [];

        await db.appeals.each(function (r) {
            var k = normKey(r.folder, r.fileName);
            if (!k || k.indexOf('||') === -1 || k.endsWith('||')) return;
            // درجة الجودة: المحتوى النصي أهم شيء للبحث، ثم الملفات الثنائية
            var contentLen = (typeof r.content === 'string' ? r.content.length : 0);
            var score = contentLen * 10                         // المحتوى النصي: الأعلى أولوية
                      + (r.fileBase64 ? 5000000 : 0)          // ملف base64
                      + (r.fileBlob   ? 5000000 : 0)          // ملف blob
                      + (r.filePath   ? 100000  : 0)          // مسار ملف نسبي
                      + (r.isIndexed === 1 ? 10000 : 0)       // مُفهرَس
                      + (r.autoSummary ? r.autoSummary.length : 0); // ملخص
            var cur = best.get(k);
            if (!cur) {
                best.set(k, { id: r.id, score: score });
                return;
            }
            if (score > cur.score) {
                toDelete.push(cur.id);
                best.set(k, { id: r.id, score: score });
            } else {
                toDelete.push(r.id);
            }
        }).catch(function (e) {
            warn('cursor error: ' + e.message);
        });

        if (toDelete.length === 0) {
            log('✅ لا توجد تكرارات — قاعدة البيانات سليمة (' + total + ' سجل)');
            return;
        }

        // حماية: إذا كانت نسبة الحذف أكثر من 80% فهناك خلل في المفاتيح
        var ratio = toDelete.length / total;
        if (ratio > 0.80 && total > 200) {
            warn('⛔ نسبة الحذف (' + Math.round(ratio * 100) + '%) كبيرة جداً — تم الإيقاف للحماية');
            return;
        }

        log('🧹 حذف ' + toDelete.length + ' سجل مكرر من أصل ' + total + '...');
        var BATCH = 500;
        for (var i = 0; i < toDelete.length; i += BATCH) {
            var chunk = toDelete.slice(i, i + BATCH);
            await db.appeals.bulkDelete(chunk).catch(function () {
                // محاولة حذف فردي عند الفشل
                return Promise.all(chunk.map(function (id) {
                    return db.appeals.delete(id).catch(function () {});
                }));
            });
            // منح المتصفح فرصة للتنفس
            await new Promise(function (r) { setTimeout(r, 0); });
        }

        var remaining = await db.appeals.count().catch(function () { return 0; });
        log('✅ انتهى التنظيف — المتبقي: ' + remaining.toLocaleString('ar-EG') + ' سجل');

        // مسح كاش المحتوى لأن بعض الـ IDs قد تغيّرت
        try {
            if (window._UltraCache && typeof window._UltraCache.clear === 'function') {
                window._UltraCache.clear();
            }
            if (window._contentCache && typeof window._contentCache.clear === 'function') {
                window._contentCache.clear();
            }
        } catch(e) {}

        if (typeof window.showToast === 'function') {
            window.showToast('🧹 تم حذف ' + toDelete.length.toLocaleString('ar-EG') + ' سجل مكرر تلقائياً. المتبقي: ' + remaining.toLocaleString('ar-EG'));
        }
    }

    // ─── [C] اعتراض injectPortableDB — بديل آمن بالكامل ───────────────────
    //
    // [C-CORE] منطق التصحيح مُستخرَج في دالة مستقلة (patchEngineObject) تقبل
    // أي كائن "engine" وتُرقّعه في مكانه. هذا يسمح باستدعائها من مسارين:
    //   (1) الفخ الفوري (defineProperty) في اللحظة التي يُسنَد فيها
    //       window.PortableEngine = {...} من داخل portable-engine.js نفسه —
    //       بشكل متزامن 100%، قبل أن يُتاح لأي كود لاحق (حتى لو داخل نفس
    //       الملف) استدعاء injectPortableDB غير المحمية.
    //   (2) الفحص الدوري (polling) كخط دفاع احتياطي في حال كان
    //       window.PortableEngine مُعرَّفاً بالفعل قبل تحميل anti-duplicate-fix.js
    //       (مثلاً في حال تغيّر ترتيب السكربتات مستقبلاً).

    function patchEngineObject(engine) {
        if (!engine || typeof engine.injectPortableDB !== 'function') return false;
        if (engine.injectPortableDB.__antiDupPatched) return true;

        var _orig = engine.injectPortableDB;

        engine.injectPortableDB = async function safeInjectPortableDB() {
            var pkg = window.ENCYCLOPEDIA_DB;
            if (!pkg || !Array.isArray(pkg.appeals) || pkg.appeals.length === 0) {
                // لا يوجد db-data.js — ادعُ الأصلي (لن يفعل شيئاً)
                return _orig.apply(this, arguments);
            }

            // [1] هل تم الحقن في هذه الجلسة؟
            if (isAlreadyInjectedThisSession()) {
                log('⏭ تم تجاوز الحقن — مُنجز مسبقاً في هذه الجلسة');
                if (typeof window._patchFileOpener === 'function') window._patchFileOpener();
                return true;
            }

            // [2] هل تم الحقن في جلسات سابقة والبيانات سليمة؟
            var alreadyDone = await isAlreadyInjectedPersistent();
            if (alreadyDone) {
                log('⏭ تم تجاوز الحقن — البيانات محدّثة (checksum متطابق)');
                markInjectionDone(); // تحديث علامة الجلسة
                if (typeof window._patchFileOpener === 'function') window._patchFileOpener();
                return true;
            }

            // [3] حقن آمن: بدون clear()، فقط الجديد
            var db = window.db;
            if (!db || !db.appeals) {
                warn('db غير جاهز — تفويض للدالة الأصلية');
                return _orig.apply(this, arguments);
            }

            log('🔄 بدء الحقن الآمن لـ ' + pkg.appeals.length + ' سجل من db-data.js (بدون مسح)...');

            // بناء مجموعة المفاتيح الموجودة
            var existingKeys = new Set();
            await db.appeals.each(function (r) {
                existingKeys.add(normKey(r.folder, r.fileName));
            }).catch(function () {});

            var newRecords = [];
            for (var i = 0; i < pkg.appeals.length; i++) {
                var r = pkg.appeals[i];
                var k = normKey(r.folder || 'عام', r.fileName);
                if (!k || existingKeys.has(k)) continue;
                existingKeys.add(k);
                var rec = Object.assign({}, r);
                delete rec.id; // Dexie يُولّد ID
                newRecords.push(rec);
            }

            log('📊 سجلات جديدة لإضافتها: ' + newRecords.length + ' (مكررة مُتجاهلة: ' + (pkg.appeals.length - newRecords.length) + ')');

            if (newRecords.length > 0) {
                var BATCH = 100;
                for (var j = 0; j < newRecords.length; j += BATCH) {
                    var batch = newRecords.slice(j, j + BATCH);
                    await db.appeals.bulkAdd(batch).catch(function (e) {
                        // حاول سجلاً سجلاً عند وجود تعارض
                        return Promise.all(batch.map(function (rec) {
                            return db.appeals.add(rec).catch(function () {});
                        }));
                    });
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
                log('✅ تم إضافة ' + newRecords.length + ' سجل جديد');
            }

            markInjectionDone();
            if (typeof window._patchFileOpener === 'function') window._patchFileOpener();

            // تحديث الواجهة مرة واحدة فقط
            if (typeof window.loadEssentialData === 'function') {
                await window.loadEssentialData();
            }
            if (typeof window.rebuildHyperIndexAsync === 'function') {
                setTimeout(window.rebuildHyperIndexAsync, 300);
            }
            if (typeof window.showToast === 'function' && newRecords.length > 0) {
                window.showToast('✅ تم تحميل ' + newRecords.length.toLocaleString('ar-EG') + ' ملف جديد من قاعدة البيانات المحمولة 📦');
            }

            return true;
        };

        engine.injectPortableDB.__antiDupPatched = true;
        log('✅ تم تثبيت حماية injectPortableDB');
        return true;
    }

    function interceptInjectPortableDB() {
        return patchEngineObject(window.PortableEngine);
    }

    // ─── [C-EARLY] فخ فوري ومتزامن: اعتراض إسناد window.PortableEngine ─────
    //
    // المشكلة السابقة: الاعتماد فقط على الفحص الدوري (setInterval كل 500ms)
    // يترك نافذة سباق (race condition) — إذا نادى portable-engine.js على
    // injectPortableDB() الخاصة به فور تحميله (سطر واحد داخل نفس الملف)
    // فقد يحدث ذلك قبل أن تصل أول دورة فحص من anti-duplicate-fix.js،
    // فتُنفَّذ النسخة الأصلية غير المحمية وتُكرَّر قاعدة البيانات بأكملها.
    //
    // الحل: بدلاً من انتظار ظهور window.PortableEngine، نعترض عملية
    // الإسناد (assignment) نفسها عبر Object.defineProperty. في اللحظة التي
    // ينفّذ فيها portable-engine.js السطر `window.PortableEngine = {...}`،
    // الـ setter هنا يعمل بشكل متزامن فوراً، يُرقّع injectPortableDB
    // قبل تخزين القيمة — أي قبل أن يتمكن أي سطر لاحق (حتى داخل نفس
    // الملف) من استدعاء الدالة غير المحمية. هذا يُغلق السباق نهائياً
    // بغض النظر عن توقيت الشبكة أو سرعة الجهاز.
    //
    // هذا الفخ يُثبَّت فور تنفيذ anti-duplicate-fix.js نفسه (وليس بعد
    // DOMContentLoaded)، أي قبل أن يبدأ PORTABLE-LOADER في تحميل
    // portable-engine.js بوقت كافٍ دائماً.

    (function installEarlyPortableEngineTrap() {
        // إن كان window.PortableEngine مُعرَّفاً بالفعل (حالة نادرة لو تغيّر
        // ترتيب السكربتات)، رقّعه فوراً ولا داعي للفخ.
        if (window.PortableEngine) {
            patchEngineObject(window.PortableEngine);
            _earlyTrapInstalled = 'not-needed (already defined)';
            return;
        }

        var _backingValue;
        try {
            Object.defineProperty(window, 'PortableEngine', {
                configurable: true,
                enumerable: true,
                get: function () {
                    return _backingValue;
                },
                set: function (value) {
                    // رقّع الكائن فور إسناده، قبل أي استخدام لاحق له
                    patchEngineObject(value);
                    _backingValue = value;
                }
            });
            _earlyTrapInstalled = true;
            log('🪤 تم تثبيت الفخ الفوري على window.PortableEngine (حماية ضد سباق التوقيت)');
        } catch (e) {
            _earlyTrapInstalled = false;
            warn('تعذّر تثبيت الفخ الفوري: ' + e.message + ' — سيُعتمَد على الفحص الدوري فقط');
        }
    })();

    // ─── [D] اعتراض loadEssentialData — منع دمج ENCYCLOPEDIA_DB المكرر ────



    function interceptLoadEssentialData() {
        if (typeof window.loadEssentialData !== 'function') return;
        if (window.loadEssentialData.__antiDupEncycPatch) return;

        var _orig = window.loadEssentialData;

        // مجموعة تتتبع IDs التي أُعطيت لسجلات ENCYCLOPEDIA_DB في هذه الجلسة
        var _encyclopediaIdsInjected = new Set();
        var _encyclopediaInjectedThisSession = false;

        window.loadEssentialData = async function antiDupLoadEssentialData() {
            // تنفيذ الأصلي (يقرأ IndexedDB وينظف allAppeals)
            var result = await _orig.apply(this, arguments);

            // الآن: هل تم دمج ENCYCLOPEDIA_DB أكثر من مرة في الجلسة؟
            // الدالة الأصلية تدمج window.ENCYCLOPEDIA_DB في كل استدعاء.
            // نحن نرصد ذلك ونمنع التكرار الثاني+.
            var pkg = window.ENCYCLOPEDIA_DB;
            if (!pkg || !Array.isArray(pkg.appeals) || pkg.appeals.length === 0) {
                return result;
            }

            if (_encyclopediaInjectedThisSession) {
                // فلتر allAppeals من أي تكرارات أحدثها الدمج المتكرر
                if (typeof window.allAppeals !== 'undefined' && Array.isArray(window.allAppeals)) {
                    var seen = new Set();
                    var filtered = [];
                    for (var i = 0; i < window.allAppeals.length; i++) {
                        var a = window.allAppeals[i];
                        var k = normKey(a.folder, a.fileName);
                        if (seen.has(k)) continue;
                        seen.add(k);
                        filtered.push(a);
                    }
                    if (filtered.length < window.allAppeals.length) {
                        warn('⚠️ تم اكتشاف ' + (window.allAppeals.length - filtered.length) + ' سجل مكرر في الذاكرة — تم التنظيف');
                        window.allAppeals = filtered;
                        try { window.allAppeals = window.allAppeals; } catch(e){}
                        // تحديث العرض بعد التصفية
                        if (typeof window.updateStatsDisplayFast === 'function') window.updateStatsDisplayFast();
                        if (typeof window.updateFolderTree === 'function') window.updateFolderTree();
                    }
                }
            } else {
                _encyclopediaInjectedThisSession = true;
            }

            return result;
        };

        window.loadEssentialData.__antiDupEncycPatch = true;
        window.loadEssentialData.__antiDupWrapped = _orig.__hsExposeWrapped || false;
        log('✅ تم تثبيت حماية loadEssentialData');
    }

    // ─── [F] منع الدمج المتكرر لـ ENCYCLOPEDIA_DB داخل allAppeals ───────────
    //         بدلاً من debounce (الذي يحجب استدعاءات شرعية)، نستخدم
    //         علامة بسيطة تمنع دمج ENCYCLOPEDIA_DB مرتين في الجلسة.
    //         هذا يُعالج المشكلة من المصدر دون المساس بتحميل IndexedDB.

    // لا يوجد debounce هنا — تم حذفه لأنه كان يحجب تحميل البيانات ويُسبب
    // نتائج بحث 0 عندما يُستدعى loadEssentialData مرة ثانية بعد التنظيف.

    // ─── نقطة التثبيت الرئيسية ─────────────────────────────────────────────

    var _installAttempts = 0;
    var _installTimer = null;
    var _cleanupDone = false;
    var _patchesDone = false;

    async function installPatches() {
        // [C] اعتراض portable-engine
        if (window.PortableEngine && window.PortableEngine.injectPortableDB) {
            interceptInjectPortableDB();
        }

        // [D] اعتراض loadEssentialData
        if (typeof window.loadEssentialData === 'function') {
            interceptLoadEssentialData();
        }

        _patchesDone = !!(
            (window.PortableEngine && window.PortableEngine.injectPortableDB &&
             window.PortableEngine.injectPortableDB.__antiDupPatched) &&
            typeof window.loadEssentialData === 'function' &&
            window.loadEssentialData.__antiDupEncycPatch
        );

        return _patchesDone;
    }

    async function tryInstall() {
        _installAttempts++;

        var done = await installPatches().catch(function (e) {
            warn('installPatches error: ' + e.message);
            return false;
        });

        // [E] تنظيف التكرارات فور جاهزية DB (مرة واحدة)
        if (!_cleanupDone && window.db && window.db.appeals) {
            _cleanupDone = true;
            setTimeout(async function () {
                try {
                    await cleanupExistingDuplicates(window.db);
                    // بعد التنظيف، أعد تحميل الواجهة
                    if (typeof window.loadEssentialData === 'function') {
                        await window.loadEssentialData();
                    }
                } catch (e) {
                    warn('cleanup error: ' + e.message);
                }
            }, 500);
        }

        if (done) {
            if (_installTimer) clearInterval(_installTimer);
            log('🏁 جميع الحمايات مُثبَّتة بعد ' + _installAttempts + ' محاولة');
        } else if (_installAttempts > 120) {
            if (_installTimer) clearInterval(_installTimer);
            warn('⏰ انتهت المهلة — بعض الحمايات قد لا تكون مُثبَّتة');
        }
    }

    // تثبيت عند الجاهزية
    function startInstall() {
        log('🚀 بدء تثبيت الحمايات...');
        tryInstall();
        _installTimer = setInterval(tryInstall, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startInstall, { once: true });
    } else {
        // الصفحة جاهزة — ابدأ فوراً لكن انتظر init() الخارجي
        setTimeout(startInstall, 0);
    }

    // ─── واجهة عامة للتشخيص ────────────────────────────────────────────────

    window.AntiDupFix = {
        version: '1.0',

        /** تشخيص شامل */
        diagnose: async function () {
            var db = window.db;
            var count = db && db.appeals ? await db.appeals.count().catch(function () { return -1; }) : -1;
            var memCount = Array.isArray(window.allAppeals) ? window.allAppeals.length : -1;
            var encCount = (window.ENCYCLOPEDIA_DB && Array.isArray(window.ENCYCLOPEDIA_DB.appeals))
                ? window.ENCYCLOPEDIA_DB.appeals.length : 0;
            var cs = calcEncyclopediaChecksum();
            var sessionInjected = isAlreadyInjectedThisSession();
            var lsChecksum = localStorage.getItem(LS_CHECKSUM_KEY);

            // فحص تكرارات في الذاكرة
            var memDups = 0;
            if (Array.isArray(window.allAppeals)) {
                var seen = new Set();
                window.allAppeals.forEach(function (a) {
                    var k = normKey(a.folder, a.fileName);
                    if (seen.has(k)) memDups++;
                    else seen.add(k);
                });
            }

            var report = {
                dbCount: count,
                memoryCount: memCount,
                encyclopediaDbCount: encCount,
                memoryDuplicates: memDups,
                expectedCount: encCount || '(لا يوجد db-data.js)',
                sessionInjected: sessionInjected,
                checksumCurrent: cs,
                checksumStored: lsChecksum,
                checksumMatch: cs === lsChecksum,
                patchesInstalled: {
                    injectPortableDB: !!(window.PortableEngine && window.PortableEngine.injectPortableDB && window.PortableEngine.injectPortableDB.__antiDupPatched),
                    loadEssentialData: !!(typeof window.loadEssentialData === 'function' && window.loadEssentialData.__antiDupEncycPatch),
                    earlyTrapInstalled: _earlyTrapInstalled
                }
            };
            console.table(report);
            return report;
        },

        /** تنظيف يدوي فوري */
        cleanup: async function () {
            if (!window.db || !window.db.appeals) {
                console.warn(TAG + ' DB غير جاهز');
                return;
            }
            await cleanupExistingDuplicates(window.db);
            if (typeof window.loadEssentialData === 'function') await window.loadEssentialData();
        },

        /** إعادة ضبط علامات الحقن (للاختبار) */
        resetFlags: function () {
            sessionStorage.removeItem(SESSION_INJECTED_KEY);
            localStorage.removeItem(LS_CHECKSUM_KEY);
            log('🔄 تم إعادة ضبط علامات الحقن');
        }
    };

    log('✅ تم تسجيل AntiDupFix v1.0 | استخدم AntiDupFix.diagnose() للتشخيص');

})();
