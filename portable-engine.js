/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   موسوعة نيابة النقض الجنائي — محرك التوزيع المحمول                        ║
 * ║   Portable Encyclopedia Distribution Engine v1.0                           ║
 * ║                                                                            ║
 * ║   المؤلف: حسني صفوت عبد المجيد                                              ║
 * ║   © 2026 — جميع الحقوق محفوظة وفقاً لقانون حماية الملكية الفكرية رقم 82   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * هيكل التوزيع المطلوب:
 * ─────────────────────────────────────────────────────────────────────────────
 *   📁 الموسوعة/
 *   ├── index.html            ← الموسوعة الأصلية (بعد إضافة سطر الاستدعاء)
 *   ├── portable-engine.js    ← هذا الملف
 *   ├── db-data.js            ← ينتجه المدير بزر "بناء وتصدير"
 *   └── 📁 files/             ← نفس هيكل المجلدات الأصلي
 *       ├── 📁 قتل عمد/
 *       │   ├── حكم-001.pdf
 *       │   └── مذكرة-002.docx
 *       └── 📁 مخدرات/
 *           └── حكم-101.pdf
 *
 * للإضافة إلى index.html — أضف هذا السطر قبل </body>:
 *   <script src="portable-engine.js"><\/script>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * الوحدات المضمّنة:
 *   [A] كاشف وضع التشغيل  — يحدد هل نحن في وضع توزيع أم تطوير
 *   [B] مُحمِّل البيانات   — يحقن window.ENCYCLOPEDIA_DB في IndexedDB
 *   [C] مُصدِّر المدير     — يبني db-data.js ويُصدّره للتوزيع
 *   [D] نظام Delta Sync    — تصدير/استيراد التحديثات بين أعضاء الفريق
 *   [E] مدير المسارات      — يحوّل روابط فتح الملفات إلى مسارات نسبية
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // [0] ثوابت النظام
    // ═══════════════════════════════════════════════════════════════
    var PE_VERSION       = '1.0.0';
    var PE_DB_GLOBAL     = 'ENCYCLOPEDIA_DB';      // اسم الكائن العالمي في db-data.js
    var PE_DB_FILE       = 'db-data.js';            // اسم ملف قاعدة البيانات للتوزيع
    var PE_FILES_DIR     = 'files';                 // اسم مجلد الملفات
    var PE_META_KEY      = 'pe_version_v1';         // مفتاح التحقق من الإصدار في IndexedDB
    var PE_DELTA_PREFIX  = 'pe_delta_';             // بادئة مفاتيح التعديلات الجديدة
    var PE_ADMIN_PASS    = 'Hosni2026@Niaba';       // كلمة مرور المدير (نفس ADMIN_PASS)

    // ═══════════════════════════════════════════════════════════════
    // [A] كاشف وضع التشغيل
    // ═══════════════════════════════════════════════════════════════

    /**
     * هل نحن في وضع التوزيع المحمول؟
     * يتحقق من وجود window.ENCYCLOPEDIA_DB أو ملف db-data.js
     */
    function isPortableMode() {
        return !!window[PE_DB_GLOBAL];
    }

    /**
     * هل يتم التشغيل عبر بروتوكول file:// ؟
     */
    function isLocalFile() {
        return window.location.protocol === 'file:';
    }

    // ═══════════════════════════════════════════════════════════════
    // [B] مُحمِّل البيانات الفوري — Instant Data Injector
    // ═══════════════════════════════════════════════════════════════

    /**
     * يقوم بتحميل البيانات من db-data.js أو encyclopedia.db
     */
    async function injectPortableDB() {
        // 1. محاولة تحميل قاعدة البيانات الاحترافية (SQLite) أولاً
        if (window.ProfessionalDB) {
            try {
                var profOk = await window.ProfessionalDB.init();
                if (profOk) {
                    // التحقق من وجود بيانات في SQLite
                    var res = window.ProfessionalDB.db.exec("SELECT count(*) FROM appeals");
                    var count = res[0].values[0][0];
                    if (count > 0) {
                        _peLog('💎 تم تحميل قاعدة البيانات الاحترافية (SQLite) - عدد السجلات: ' + count);
                        // نقوم بتعبئة allAppeals من SQLite لضمان عمل بقية النظام
                        var all = window.ProfessionalDB.db.exec("SELECT id, fileName, folder, docType, fileType, crimeType, uploadDate, appealNumber, isIndexed, notes, crimeLabels FROM appeals");
                        if (all.length) {
                            var cols = all[0].columns;
                            allAppeals = all[0].values.map(function(row) {
                                var r = {};
                                cols.forEach(function(c, i) { r[c] = row[i]; });
                                return r;
                            });
                        }
                        _patchFileOpener();
                        if (typeof loadEssentialData === 'function') await loadEssentialData();
                        return true;
                    }
                }
            } catch(e) {
                _peLog('⚠️ فشل تحميل SQLite: ' + e.message);
            }
        }

        // 2. العودة للطريقة التقليدية (db-data.js) إذا لم يتوفر SQLite
        var pkg = window[PE_DB_GLOBAL];
        if (!pkg || !Array.isArray(pkg.appeals)) {
            console.warn('[PE] ENCYCLOPEDIA_DB غير موجود أو فارغ');
            return false;
        }

        _peLog('📦 جاري التحقق من إصدار db-data.js... الإصدار: ' + (pkg.version || 1));

        // انتظر حتى يتم تهيئة Dexie
        var db = await _waitForDb(10000);
        if (!db) {
            console.warn('[PE] لم يتم تهيئة قاعدة البيانات بعد 10 ثواني — سيتم المحاولة لاحقاً');
            setTimeout(injectPortableDB, 2000);
            return false;
        }

        // تحقق من الإصدار المخزّن
        var storedVersion = 0;
        try {
            if (db.metadata) {
                var meta = await db.metadata.get(PE_META_KEY);
                storedVersion = meta ? (meta.value || 0) : 0;
            }
        } catch(e) {
            // جدول metadata غير موجود — لا بأس، سنستخدم count
        }

        var pkgVersion = pkg.version || 1;
        var currentCount = await db.appeals.count().catch(function(){return 0;});

        _peLog('📊 الإصدار المخزّن: ' + storedVersion + ' | إصدار db-data.js: ' + pkgVersion + ' | السجلات الحالية: ' + currentCount);

        // ══════════════════════════════════════════════════════════════
        // [ANTI-DUP-FIX] الحماية الجذرية: استخدام localStorage checksum
        // ══════════════════════════════════════════════════════════════
        var PE_LS_CHECKSUM_KEY = 'pe_db_checksum_v1';
        var PE_SESSION_KEY     = 'pe_session_injected_v1';
        var currentChecksum    = 'v' + pkgVersion + '_n' + pkg.appeals.length;
        var storedChecksum     = localStorage.getItem(PE_LS_CHECKSUM_KEY);
        var sessionDone        = sessionStorage.getItem(PE_SESSION_KEY) === currentChecksum;

        // شرط الحماية الأول: الجلسة الحالية
        if (sessionDone) {
            _peLog('⏭ تم تجاوز الحقن — مُنجز في هذه الجلسة (' + currentChecksum + ')');
            _patchFileOpener();
            return true;
        }

        // شرط الحماية الثاني: checksum + عدد سجلات كافٍ
        if (storedChecksum === currentChecksum && currentCount >= Math.floor(pkg.appeals.length * 0.85)) {
            _peLog('⏭ تم تجاوز الحقن — قاعدة البيانات محدّثة (' + currentChecksum + ')');
            sessionStorage.setItem(PE_SESSION_KEY, currentChecksum);
            _patchFileOpener();
            return true;
        }

        // شرط الحماية القديم كطبقة إضافية
        if (pkgVersion <= storedVersion && currentCount >= pkg.appeals.length * 0.9) {
            _peLog('✅ قاعدة البيانات محدّثة (version guard) — لا حاجة للحقن');
            sessionStorage.setItem(PE_SESSION_KEY, currentChecksum);
            localStorage.setItem(PE_LS_CHECKSUM_KEY, currentChecksum);
            _patchFileOpener();
            return true;
        }

        // ══════════════════════════════════════════════════════════════
        // [ANTI-DUP-FIX] حقن آمن: بناء مجموعة المفاتيح الموجودة أولاً
        // ثم إضافة الجديد فقط — بدون clear() إطلاقاً
        // ══════════════════════════════════════════════════════════════
        _peLog('🔄 بدء الحقن الآمن لـ ' + pkg.appeals.length + ' سجل (بدون مسح DB)...');
        _showInjectionProgress('جاري تحميل قاعدة البيانات...', 0);

        try {
            // بناء مجموعة مفاتيح السجلات الموجودة
            var existingKeys = new Set();
            var _normK = function(folder, fileName) {
                var f = String(folder || 'عام').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim() || 'عام';
                var n = String(fileName || '').replace(/\\/g, '/').split('/').pop().trim();
                return f.toLowerCase().replace(/\s+/g,'') + '||' + n.toLowerCase().replace(/\s+/g,'');
            };
            await db.appeals.each(function(r) {
                existingKeys.add(_normK(r.folder, r.fileName));
            }).catch(function() {});

            _peLog('📊 سجلات موجودة في DB: ' + existingKeys.size);

            // فلترة: الجديد فقط
            var newRecords = [];
            for (var qi = 0; qi < pkg.appeals.length; qi++) {
                var qr = pkg.appeals[qi];
                var qk = _normK(qr.folder || 'عام', qr.fileName);
                if (existingKeys.has(qk)) continue;
                existingKeys.add(qk);
                var qrec = Object.assign({}, qr);
                delete qrec.id;
                newRecords.push(qrec);
            }

            _peLog('📊 سجلات جديدة: ' + newRecords.length + ' | مكررة متجاهلة: ' + (pkg.appeals.length - newRecords.length));

            var BATCH = 100;
            var total = newRecords.length;

            for (var i = 0; i < total; i += BATCH) {
                var batch = newRecords.slice(i, i + BATCH);
                await db.appeals.bulkAdd(batch).catch(function(e) {
                    // محاولة فردية عند التعارض
                    return Promise.all(batch.map(function(rec) {
                        return db.appeals.add(rec).catch(function() {});
                    }));
                });

                var pct = Math.round((i + batch.length) / total * 100);
                _showInjectionProgress('تحميل البيانات... ' + pct + '%', pct);
                await _yieldUI();
            }

            // حفظ checksum في localStorage و sessionStorage
            localStorage.setItem(PE_LS_CHECKSUM_KEY, currentChecksum);
            sessionStorage.setItem(PE_SESSION_KEY, currentChecksum);

            // حفظ رقم الإصدار في metadata إن كان متاحاً
            try {
                if (db.metadata) {
                    await db.metadata.put({ key: PE_META_KEY, value: pkgVersion, updatedAt: Date.now() });
                }
            } catch(e) {}

            _hideInjectionProgress();
            _peLog('✅ تم إضافة ' + total + ' سجل جديد في ' + ((Date.now() - _peStartTime) / 1000).toFixed(1) + 'ث');

            // إعادة تحميل البيانات في الواجهة
            if (typeof loadEssentialData === 'function') {
                await loadEssentialData();
            }
            if (typeof rebuildHyperIndexAsync === 'function') {
                setTimeout(rebuildHyperIndexAsync, 300);
            }

            _patchFileOpener();

            if (typeof showToast === 'function' && total > 0) {
                showToast('✅ تم تحميل ' + total.toLocaleString('ar-EG') + ' ملف جديد من قاعدة البيانات المحمولة 📦');
            }

            return true;
        } catch(e) {
            _hideInjectionProgress();
            console.error('[PE] خطأ في الحقن:', e);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // [C] مُصدِّر المدير — Admin Export Mode
    // ═══════════════════════════════════════════════════════════════

    /**
     * يحول قاعدة البيانات الحالية إلى SQLite مضغوطة ويُصدّرها كملف .db
     */
    async function adminConvertToProfessionalDB() {
        try {
            var db_inst = window.ProfessionalDB;
            if (!db_inst) { alert('❌ محرك ProfessionalDB غير متاح'); return false; }
            await db_inst.init();

            var db = await _waitForDb(5000);
            if (!db) { alert('❌ قاعدة البيانات غير جاهزة'); return false; }

            _showAdminProgress('جاري تحويل البيانات إلى SQLite مضغوط...', 10);

            var allRecords = await db.appeals.toArray();
            if (!allRecords.length) { alert('⚠️ لا توجد بيانات لتحويلها'); _hideAdminProgress(); return false; }

            for (var i = 0; i < allRecords.length; i++) {
                await db_inst.insertRecord(allRecords[i]);
                var pct = Math.round((i + 1) / allRecords.length * 100);
                if (i % 10 === 0) _showAdminProgress('تحويل السجل ' + (i+1) + ' من ' + allRecords.length + '...', pct);
                await _yieldUI();
            }

            _showAdminProgress('جاري تصدير ملف .db...', 95);
            var blob = await db_inst.exportDbFile();
            _downloadBlob(blob, 'encyclopedia.db');

            _hideAdminProgress();
            alert('✅ تم التحويل بنجاح!\n\nتم إنشاء ملف encyclopedia.db مضغوط واحترافي.\nيمكنك الآن توزيعه بدلاً من db-data.js');
            return true;
        } catch(e) {
            _hideAdminProgress();
            console.error('[PE] Conversion error:', e);
            alert('❌ حدث خطأ أثناء التحويل: ' + e.message);
            return false;
        }
    }

    /**
     * يُصدِّر قاعدة البيانات الحالية كملف db-data.js للتوزيع.
     * يحتوي على جميع البيانات الوصفية والمحتوى النصي — دون الـ Blobs (الملفات ذاتها موجودة في مجلد files/).
     *
     * صيغة الملف الناتج:
     *   window.ENCYCLOPEDIA_DB = {
     *     version: N,
     *     generatedAt: "...",
     *     appeals: [...],     // كل السجلات بدون fileBlob/fileBase64
     *     stats: { total, indexed, memos, judgments }
     *   };
     */
    async function adminExportDB(options) {
        options = options || {};

        // التحقق من صلاحية المدير
        if (!options.skipAuth) {
            var pass = prompt('أدخل كلمة مرور المدير لتصدير قاعدة البيانات:');
            if (pass !== PE_ADMIN_PASS) {
                alert('❌ كلمة المرور غير صحيحة');
                return false;
            }
        }

        var db = await _waitForDb(5000);
        if (!db) { alert('❌ قاعدة البيانات غير جاهزة'); return false; }

        _showAdminProgress('جاري قراءة السجلات من قاعدة البيانات...', 0);

        try {
            // [HS-SAFE-EXPORT] لا toArray() لكل السجلات ولا JSON.stringify لحزمة واحدة:
            // السبب الجذري لـ "Invalid string length" هو بناء نص JS واحد أطول من حد V8 (~512 مليون حرف).
            // الحل: قراءة على دفعات، كل سجل يُحوَّل بمفرده، وتُقسَّم النتيجة إلى أجزاء db-data.js و db-data-2.js ...
            var keys = await db.appeals.toCollection().primaryKeys();
            var total = keys.length;

            if (!total) { alert('⚠️ لا توجد بيانات للتصدير'); _hideAdminProgress(); return false; }

            _showAdminProgress('جاري معالجة ' + total + ' سجل...', 10);

            var stats = { total: 0, indexed: 0, memos: 0, judgments: 0, folders: new Set() };
            var PART_CHARS = 40 * 1024 * 1024;   // حجم الجزء الواحد (حرف) — أقل بكثير من حد V8
            var READ_BATCH = 100;
            var bodies = [];                      // كل جزء = Blob (يُخزَّن على القرص لا في الذاكرة)
            var pieces = [], curChars = 0;

            function closePart() {
                if (!pieces.length) return;
                bodies.push(new Blob([pieces.join(',\n')], { type: 'text/javascript;charset=utf-8' }));
                pieces = []; curChars = 0;
            }

            for (var i = 0; i < total; i += READ_BATCH) {
                var rows = (await db.appeals.bulkGet(keys.slice(i, i + READ_BATCH))).filter(Boolean);
                for (var j = 0; j < rows.length; j++) {
                    var r = rows[j];
                    var str = JSON.stringify(_stripBlobFromRecord(r));   // سجل واحد = نص صغير
                    if (curChars > 0 && curChars + str.length > PART_CHARS) closePart();
                    pieces.push(str); curChars += str.length;
                    stats.total++;
                    if (r.isIndexed === 1) stats.indexed++;
                    if (r.docType === 'مذكرة') stats.memos++;
                    else stats.judgments++;
                    if (r.folder) stats.folders.add(r.folder);
                }
                var pct = Math.round(Math.min(i + READ_BATCH, total) / total * 80) + 10;
                _showAdminProgress('معالجة ' + Math.min(i + READ_BATCH, total) + ' / ' + total + ' سجل...', pct);
                await _yieldUI();
            }
            closePart();

            // بناء حزمة التوزيع
            var currentVersion = 1;
            try {
                if (db.metadata) {
                    var meta = await db.metadata.get(PE_META_KEY);
                    currentVersion = meta ? ((meta.value || 0) + 1) : 1;
                }
            } catch(e) {}

            var pkg = {
                version: options.version || currentVersion,
                generatedAt: new Date().toISOString(),
                generatedBy: 'حسني صفوت عبد المجيد — نيابة النقض الجنائي',
                appVersion: 'Enterprise v2026 PRO',
                parts: bodies.length,
                stats: {
                    total: stats.total,
                    indexed: stats.indexed,
                    memos: stats.memos,
                    judgments: stats.judgments,
                    folders: stats.folders.size
                }
            };

            _showAdminProgress('جاري بناء الملف... هذا قد يستغرق دقيقة', 90);
            await _yieldUI();

            var banner = '// ================================================================\n' +
                '// موسوعة نيابة النقض الجنائي — قاعدة البيانات المحمولة\n' +
                '// المؤلف: حسني صفوت عبد المجيد\n' +
                '// الإصدار: ' + pkg.version + ' | ' + pkg.generatedAt + '\n' +
                '// الإجمالي: ' + pkg.stats.total + ' ملف | ' + pkg.stats.indexed + ' مفهرس | الأجزاء: ' + pkg.parts + '\n' +
                '// ================================================================\n';

            // الجزء 1 (db-data.js) يعرّف الكائن ويحمل الرأس؛ الأجزاء 2..n تُضيف السجلات إليه
            var headJson = JSON.stringify(pkg);
            var files = [];
            for (var p = 0; p < bodies.length; p++) {
                var fname = (p === 0) ? PE_DB_FILE : PE_DB_FILE.replace(/\.js$/, '-' + (p + 1) + '.js');
                var parts;
                if (p === 0) {
                    parts = [banner, '(function(){\nwindow.' + PE_DB_GLOBAL + ' = Object.assign(',
                             headJson, ', { appeals: [\n', bodies[p], '\n] });\n})();'];
                } else {
                    parts = [banner, '(function(){\nvar D = window.' + PE_DB_GLOBAL + '; if (!D) return;\nvar a = [\n',
                             bodies[p], '\n];\nfor (var i = 0; i < a.length; i++) D.appeals.push(a[i]);\n})();'];
                }
                files.push({ name: fname, blob: new Blob(parts, { type: 'text/javascript;charset=utf-8' }) });
            }
            var totalSize = files.reduce(function(sum, f) { return sum + f.blob.size; }, 0);

            _showAdminProgress('جاري حفظ الملف... (' + _formatBytes(totalSize) + ')', 95);
            await _yieldUI();

            // تحميل الملف / الملفات
            if (files.length === 1) {
                _downloadBlob(files[0].blob, files[0].name);
            } else if (typeof JSZip !== 'undefined') {
                var zip = new JSZip();
                files.forEach(function(f) { zip.file('db-data/' + f.name, f.blob); }); // كل الأجزاء داخل مجلد واحد
                var zblob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 }, streamFiles: true });
                _downloadBlob(zblob, 'db-data-package_v' + pkg.version + '.zip');
            } else {
                for (var d = 0; d < files.length; d++) { _downloadBlob(files[d].blob, files[d].name); await new Promise(function(r) { setTimeout(r, 700); }); }
            }

            // تحديث الإصدار في DB
            try {
                if (db.metadata) {
                    await db.metadata.put({ key: PE_META_KEY, value: pkg.version, updatedAt: Date.now() });
                }
            } catch(e) {}

            _hideAdminProgress();

            var msg = '✅ تم تصدير db-data.js بنجاح!\n\n' +
                '📊 الإجمالي: ' + pkg.stats.total + ' سجل\n' +
                '🔢 الإصدار: ' + pkg.version + '\n' +
                '📦 الحجم: ' + _formatBytes(totalSize) + (files.length > 1 ? ' (مقسَّم إلى ' + files.length + ' أجزاء داخل ملف ZIP)' : '') + '\n\n' +
                'لتفعيل التوزيع المحمول:\n' +
                (files.length > 1 ? '1. فكّ ضغط الـ ZIP وضع المجلد db-data بالكامل بجوار ملف index.html (الأجزاء بداخله)\n' : '1. ضع db-data.js في نفس مجلد index.html\n') +
                '2. تأكد أن مجلد files/ يحتوي على الملفات الأصلية\n' +
                '3. أرسل مجلد الموسوعة بالكامل (ZIP أو USB)';
            alert(msg);

            return true;
        } catch(e) {
            _hideAdminProgress();
            console.error('[PE] خطأ في التصدير:', e);
            alert('❌ حدث خطأ أثناء التصدير: ' + e.message);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // [D] نظام Delta Sync — تصدير/استيراد التحديثات
    // ═══════════════════════════════════════════════════════════════

    /**
     * تصدير التحديثات الجديدة فقط.
     * يُصدِّر السجلات المضافة بعد تاريخ آخر إصدار معروف (أو كل السجلات إن لم يكن هناك إصدار).
     */
    async function exportDeltaUpdates() {
        var db = await _waitForDb(5000);
        if (!db) { alert('❌ قاعدة البيانات غير جاهزة'); return false; }

        try {
            // جلب تاريخ آخر مزامنة من localStorage
            var lastSyncTime = parseInt(localStorage.getItem('pe_last_sync_time') || '0');
            var lastSyncCount = parseInt(localStorage.getItem('pe_last_sync_count') || '0');

            // [HS-SAFE-EXPORT] قراءة على دفعات + Blob من أجزاء (لا JSON.stringify لحزمة ضخمة)
            var dKeys = await db.appeals.toCollection().primaryKeys();
            var allCount = dKeys.length;
            var recStrs = [], newCount = 0;
            for (var di = 0; di < dKeys.length; di += 100) {
                var drows = (await db.appeals.bulkGet(dKeys.slice(di, di + 100))).filter(Boolean);
                for (var dj = 0; dj < drows.length; dj++) {
                    var dr = drows[dj];
                    if (lastSyncTime > 0 && !((dr.uploadDate || 0) > lastSyncTime)) continue;
                    recStrs.push(JSON.stringify(_stripBlobFromRecord(dr))); newCount++;
                }
                await _yieldUI();
            }
            var newRecords = { length: newCount };

            if (!newRecords.length) {
                alert('لا توجد تحديثات جديدة منذ آخر مزامنة (' + new Date(lastSyncTime).toLocaleDateString('ar-EG') + ')');
                return false;
            }

            var pkgHead = JSON.stringify({
                format: 'pe-delta',
                version: '1.0',
                exportedAt: Date.now(),
                exportedAtISO: new Date().toISOString(),
                exportedBy: 'نظام التوزيع المحمول',
                baseSyncTime: lastSyncTime
            });
            var blob = new Blob([pkgHead.slice(0, -1), ',"records":[\n', recStrs.join(',\n'), '\n]}'], { type: 'application/json;charset=utf-8' });
            var filename = 'updates_' + new Date().toISOString().slice(0, 10) + '_' + newRecords.length + 'files.json';
            _downloadBlob(blob, filename);

            // تحديث وقت آخر مزامنة
            localStorage.setItem('pe_last_sync_time', Date.now().toString());
            localStorage.setItem('pe_last_sync_count', allCount.toString());

            if (typeof showToast === 'function') {
                showToast('✅ تم تصدير ' + newRecords.length + ' تحديث جديد');
            }
            return true;
        } catch(e) {
            console.error('[PE] خطأ في تصدير التحديثات:', e);
            alert('❌ خطأ في التصدير: ' + e.message);
            return false;
        }
    }

    /**
     * استيراد تحديثات من زميل (ملف updates.json).
     * يدمج السجلات الجديدة في قاعدة بيانات المدير بدون حذف الموجود.
     */
    async function importDeltaUpdates(file) {
        if (!file) {
            // فتح مربع حوار اختيار ملف
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async function() {
                if (this.files.length) await importDeltaUpdates(this.files[0]);
            };
            input.click();
            return;
        }

        var db = await _waitForDb(5000);
        if (!db) { alert('❌ قاعدة البيانات غير جاهزة'); return false; }

        try {
            var text = await file.text();
            var pkg = JSON.parse(text);

            if (pkg.format !== 'pe-delta') {
                alert('❌ الملف ليس بصيغة التحديثات المتوقعة (pe-delta)');
                return false;
            }

            if (!Array.isArray(pkg.records) || !pkg.records.length) {
                alert('⚠️ الملف لا يحتوي على تحديثات');
                return false;
            }

            // مجموعة المفاتيح الموجودة لتجنب التكرار
            var existingKeys = new Set();
            (await db.appeals.toArray()).forEach(function(r) {
                existingKeys.add((r.folder || 'عام') + '||' + r.fileName);
            });

            var added = 0, skipped = 0;
            var BATCH = 50;
            for (var i = 0; i < pkg.records.length; i += BATCH) {
                var batch = [];
                for (var j = 0; j < Math.min(BATCH, pkg.records.length - i); j++) {
                    var r = pkg.records[i + j];
                    var key = (r.folder || 'عام') + '||' + r.fileName;
                    if (!existingKeys.has(key)) {
                        var rec = Object.assign({}, r);
                        delete rec.id;
                        batch.push(rec);
                        existingKeys.add(key);
                        added++;
                    } else {
                        skipped++;
                    }
                }
                if (batch.length) {
                    await db.appeals.bulkAdd(batch).catch(function(){});
                }
            }

            // تحديث الواجهة
            if (typeof loadEssentialData === 'function') await loadEssentialData();
            if (typeof rebuildHyperIndexAsync === 'function') setTimeout(rebuildHyperIndexAsync, 300);

            var msg = '✅ تم استيراد التحديثات:\n\n' +
                '➕ مضاف: ' + added + ' سجل\n' +
                '⏭️ متجاهل (مكرر): ' + skipped + ' سجل\n\n' +
                'يمكنك الآن تصدير db-data.js محدّث بزر "بناء وتصدير قاعدة البيانات"';
            alert(msg);

            if (typeof showToast === 'function') {
                showToast('✅ تم استيراد ' + added + ' سجل جديد من التحديثات');
            }
            return { added: added, skipped: skipped };
        } catch(e) {
            console.error('[PE] خطأ في استيراد التحديثات:', e);
            alert('❌ خطأ في الاستيراد: ' + e.message);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // [E] مدير المسارات — يُحوّل روابط فتح الملفات إلى مسارات نسبية
    // ═══════════════════════════════════════════════════════════════

    /**
     * يُضيف آلية فتح الملفات عبر المسارات النسبية لمجلد files/.
     * بدلاً من استخراج Blob من IndexedDB، يفتح الملف مباشرة:
     *   files/{folder}/{fileName}
     *
     * هذا يعمل فقط عندما:
     *   1. يتم التشغيل من خادم محلي (http://localhost أو http://127.0.0.1)
     *   2. أو عبر متصفح يدعم fetch من file:// (Chrome مع --allow-file-access-from-files)
     *
     * في حالة file:// العادية — يُبلّغ المستخدم بفتح المجلد يدوياً.
     */
    function _patchFileOpener() {
        if (!isPortableMode()) return;

        // نسخ الدالة الأصلية
        var _originalDownloadFile = window.downloadFile;
        var _originalOpenFile     = window.openFile || window.viewFile;

        // دالة بناء مسار الملف النسبي
        window._PE_getRelativePath = function(folder, fileName) {
            var cleanFolder = (folder || 'عام').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            var cleanFile   = (fileName || '').replace(/\\/g, '/').replace(/^\/+/, '');
            return PE_FILES_DIR + '/' + cleanFolder + '/' + cleanFile;
        };

        // تجاوز دالة downloadFile لدعم المسارات النسبية
        window.downloadFile = async function(id) {
            var appeals = window.allAppeals || [];
            var appeal  = appeals.find(function(a) { return a.id === id; });
            if (!appeal) { if (typeof showToast === 'function') showToast('الملف غير موجود', true); return; }

            var relativePath = window._PE_getRelativePath(appeal.folder, appeal.fileName);

            // محاولة الفتح عبر رابط مباشر (يعمل في بيئة خادم)
            try {
                if (window.location.protocol !== 'file:') {
                    // بيئة خادم — افتح مباشرة
                    var a = document.createElement('a');
                    a.href = relativePath;
                    a.download = appeal.fileName;
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    if (typeof showToast === 'function') showToast('📂 ' + appeal.fileName);
                    return;
                }
            } catch(e) {}

            // بروتوكول file:// — محاولة IndexedDB أولاً
            if (appeal._hasFile) {
                if (typeof _originalDownloadFile === 'function') {
                    return _originalDownloadFile(id);
                }
            }

            // إبلاغ المستخدم بالمسار
            _showPathInfo(appeal.folder, appeal.fileName, relativePath);
        };

        // دالة عرض الملف في تبويب جديد (مسارات نسبية)
        window.PE_openFileTab = function(folder, fileName) {
            var relativePath = window._PE_getRelativePath(folder, fileName);
            if (window.location.protocol !== 'file:') {
                window.open(relativePath, '_blank');
            } else {
                _showPathInfo(folder, fileName, relativePath);
            }
        };

        _peLog('🔗 مُفعَّل: مدير المسارات النسبية لمجلد files/');
    }

    /**
     * يُظهر معلومات مسار الملف للمستخدم عند عدم إمكانية الفتح المباشر.
     */
    function _showPathInfo(folder, fileName, relativePath) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;z-index:999999;font-family:Cairo,sans-serif;direction:rtl;';
        overlay.innerHTML =
            '<div style="background:#1d2130;padding:2rem;border-radius:1.2rem;max-width:520px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,0.7);border:1px solid #c49a1b;">' +
            '<h3 style="color:#e6b422;margin-bottom:0.8rem;"><i class="fas fa-folder-open"></i> موقع الملف</h3>' +
            '<p style="color:#8896a5;font-size:0.88rem;margin-bottom:1rem;">للوصول إلى هذا الملف من مجلد الموسوعة:</p>' +
            '<div style="background:#252a38;padding:0.8rem 1rem;border-radius:0.6rem;color:#e6b422;font-size:0.9rem;word-break:break-all;border-right:3px solid #c49a1b;margin-bottom:1rem;">' +
            '<strong>📁 المسار:</strong> ' + _escHtml(relativePath) + '</div>' +
            '<div style="display:flex;gap:0.6rem;flex-wrap:wrap;">' +
            '<button onclick="navigator.clipboard.writeText(\'' + _escHtml(relativePath).replace(/'/g, "\\'") + '\'); this.textContent=\'✅ تم النسخ!\'" ' +
            'style="background:#c49a1b;color:white;border:none;border-radius:2rem;padding:0.5rem 1.2rem;cursor:pointer;font-family:Cairo;font-weight:700;">' +
            '<i class="fas fa-copy"></i> نسخ المسار</button>' +
            '<button onclick="this.closest(\'div[style*=fixed]\').remove()" ' +
            'style="background:transparent;color:#8896a5;border:1px solid #2d3347;border-radius:2rem;padding:0.5rem 1.2rem;cursor:pointer;font-family:Cairo;">إغلاق</button>' +
            '</div></div>';
        document.body.appendChild(overlay);
        overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    }

    // ═══════════════════════════════════════════════════════════════
    // [F] واجهة المستخدم — أزرار المدير والتوزيع
    // ═══════════════════════════════════════════════════════════════

    /**
     * يُثبِّت أزرار التوزيع المحمول في قسم إدارة البيانات.
     */
    function installPortableButtons() {
        var section = document.getElementById('dataManagementSection');
        if (!section || document.getElementById('pe-export-btn')) return;

        var btnContainer = section.querySelector('div[style*="display:flex"]');
        if (!btnContainer) {
            // إنشاء حاوية إن لم تُوجد
            btnContainer = section.querySelector('.db-info-row');
            if (!btnContainer) return;
        }

        // ── فاصل ──
        var sep = document.createElement('hr');
        sep.style.cssText = 'width:100%;border:none;border-top:1px dashed rgba(196,154,27,0.3);margin:0.6rem 0;';
        btnContainer.after(sep);

        // ── قسم أدوات التوزيع ──
        var portableSection = document.createElement('div');
        portableSection.id = 'pe-toolbar';
        portableSection.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center;' +
            'background:linear-gradient(135deg,rgba(196,154,27,0.06),rgba(196,154,27,0.02));' +
            'border:1.5px solid rgba(196,154,27,0.25);border-radius:0.8rem;padding:0.8rem 1rem;margin-top:0.6rem;';

        portableSection.innerHTML =
            '<span style="font-size:0.82rem;font-weight:700;color:#a67c00;white-space:nowrap;">' +
            '<i class="fas fa-box"></i> التوزيع المحمول:</span>' +

            // زر بناء وتصدير
            '<button id="pe-export-btn" class="btn btn-gold btn-sm" title="بناء db-data.js للتوزيع على الفريق">' +
            '<i class="fas fa-hammer"></i> بناء وتصدير قاعدة البيانات</button>' +

            // زر التحويل للاحترافي
            '<button id="pe-prof-convert-btn" class="btn btn-success btn-sm" title="تحويل المشروع لقاعدة بيانات SQLite احترافية ومضغوطة">' +
            '<i class="fas fa-database"></i> تحويل لقاعدة بيانات احترافية</button>' +

            // زر تصدير التحديثات
            '<button id="pe-delta-export-btn" class="btn btn-outline btn-sm" style="border-color:#a67c00;color:#a67c00;" ' +
            'title="تصدير السجلات الجديدة فقط لإرسالها للمدير">' +
            '<i class="fas fa-upload"></i> تصدير تحديثاتي</button>' +

            // زر استيراد التحديثات
            '<button id="pe-delta-import-btn" class="btn btn-outline btn-sm" style="border-color:#27ae60;color:#27ae60;" ' +
            'title="استيراد ملف تحديثات من أحد الزملاء">' +
            '<i class="fas fa-download"></i> استيراد تحديثات زميل</button>' +

            // مؤشر حالة التوزيع
            '<span id="pe-status-badge" style="font-size:0.78rem;padding:0.2rem 0.7rem;border-radius:2rem;' +
            'background:rgba(196,154,27,0.12);color:#a67c00;">جارٍ التحقق...</span>';

        sep.after(portableSection);

        // ربط الأحداث
        document.getElementById('pe-export-btn').onclick = function() {
            var btn = this;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري البناء...';
            adminExportDB().then(function() {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-hammer"></i> بناء وتصدير قاعدة البيانات';
            });
        };

        document.getElementById('pe-prof-convert-btn').onclick = function() {
            var btn = this;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري التحويل...';
            adminConvertToProfessionalDB().then(function() {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-database"></i> تحويل لقاعدة بيانات احترافية';
            });
        };

        document.getElementById('pe-delta-export-btn').onclick = function() {
            exportDeltaUpdates();
        };

        document.getElementById('pe-delta-import-btn').onclick = function() {
            importDeltaUpdates(null);
        };

        // تحديث مؤشر الحالة
        _updateStatusBadge();
    }

    /**
     * يُحدِّث شارة حالة التوزيع في الواجهة.
     */
    function _updateStatusBadge() {
        var badge = document.getElementById('pe-status-badge');
        if (!badge) return;

        var db = window.db; // الـ db من الكود الأصلي
        if (!db) { badge.textContent = '⏳ DB غير جاهز'; return; }

        db.appeals.count().then(function(count) {
            var mode = isPortableMode() ? '📦 وضع التوزيع' : '🔧 وضع التطوير';
            var lastSync = localStorage.getItem('pe_last_sync_time');
            var syncDate = lastSync ? new Date(parseInt(lastSync)).toLocaleDateString('ar-EG') : 'لم تتم';
            badge.innerHTML = mode + ' | ' + count.toLocaleString('ar-EG') + ' سجل | آخر تصدير: ' + syncDate;
        }).catch(function() {
            badge.textContent = '⚠️ خطأ في قراءة DB';
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // [G] مؤشرات التقدم
    // ═══════════════════════════════════════════════════════════════

    var _peStartTime = Date.now();
    var _injectionOverlay = null;
    var _adminProgressOverlay = null;

    function _showInjectionProgress(msg, pct) {
        _peStartTime = _peStartTime || Date.now();
        if (!_injectionOverlay) {
            _injectionOverlay = document.createElement('div');
            _injectionOverlay.id = 'pe-injection-overlay';
            _injectionOverlay.style.cssText =
                'position:fixed;inset:0;background:radial-gradient(ellipse at center,#1a1f35 0%,#0a0c14 100%);' +
                'z-index:200000;display:flex;flex-direction:column;justify-content:center;align-items:center;' +
                'font-family:Cairo,sans-serif;color:white;direction:rtl;';
            _injectionOverlay.innerHTML =
                '<i class="fas fa-gavel" style="font-size:3.5rem;color:#e6b422;margin-bottom:1.2rem;animation:pe-pulse 1.5s ease-in-out infinite;"></i>' +
                '<h2 style="font-size:1.5rem;font-weight:900;background:linear-gradient(90deg,#fff 0%,#e6b422 50%,#fff 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:0.4rem;">نيابة النقض الجنائي</h2>' +
                '<p style="color:#e6b422;font-size:0.9rem;margin-bottom:2rem;">جاري تحميل الموسوعة...</p>' +
                '<div id="pe-progress-text" style="font-size:0.92rem;color:#8896a5;margin-bottom:0.8rem;">' + msg + '</div>' +
                '<div style="width:320px;background:#2d3347;border-radius:10px;height:8px;overflow:hidden;">' +
                '<div id="pe-progress-bar" style="width:' + pct + '%;background:linear-gradient(90deg,#e6b422,#a67c00);height:100%;transition:width 0.2s;border-radius:10px;"></div>' +
                '</div>' +
                '<style>@keyframes pe-pulse{0%,100%{opacity:0.8;transform:scale(1);}50%{opacity:1;transform:scale(1.05);}}</style>';
            document.body.appendChild(_injectionOverlay);
        } else {
            var txt = document.getElementById('pe-progress-text');
            var bar = document.getElementById('pe-progress-bar');
            if (txt) txt.textContent = msg;
            if (bar) bar.style.width = pct + '%';
        }
    }

    function _hideInjectionProgress() {
        if (_injectionOverlay) {
            _injectionOverlay.style.opacity = '0';
            _injectionOverlay.style.transition = 'opacity 0.4s';
            setTimeout(function() {
                if (_injectionOverlay && _injectionOverlay.parentNode) {
                    _injectionOverlay.parentNode.removeChild(_injectionOverlay);
                }
                _injectionOverlay = null;
            }, 400);
        }
    }

    function _showAdminProgress(msg, pct) {
        if (!_adminProgressOverlay) {
            _adminProgressOverlay = document.createElement('div');
            _adminProgressOverlay.style.cssText =
                'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:200001;' +
                'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
                'font-family:Cairo,sans-serif;color:white;direction:rtl;';
            _adminProgressOverlay.innerHTML =
                '<div style="background:#1d2130;padding:2.5rem;border-radius:1.2rem;max-width:440px;width:90%;text-align:center;border:1px solid #c49a1b;">' +
                '<i class="fas fa-hammer" style="font-size:2.5rem;color:#e6b422;margin-bottom:1rem;"></i>' +
                '<h3 style="color:#e6b422;margin-bottom:0.5rem;">بناء قاعدة البيانات</h3>' +
                '<div id="pe-admin-msg" style="color:#8896a5;font-size:0.88rem;margin-bottom:1rem;">' + msg + '</div>' +
                '<div style="background:#252a38;border-radius:8px;height:8px;overflow:hidden;">' +
                '<div id="pe-admin-bar" style="width:' + pct + '%;background:linear-gradient(90deg,#e6b422,#a67c00);height:100%;transition:width 0.2s;border-radius:8px;"></div>' +
                '</div></div>';
            document.body.appendChild(_adminProgressOverlay);
        } else {
            var el = _adminProgressOverlay.querySelector('#pe-admin-msg');
            var bar = _adminProgressOverlay.querySelector('#pe-admin-bar');
            if (el) el.textContent = msg;
            if (bar) bar.style.width = pct + '%';
        }
    }

    function _hideAdminProgress() {
        if (_adminProgressOverlay && _adminProgressOverlay.parentNode) {
            _adminProgressOverlay.parentNode.removeChild(_adminProgressOverlay);
        }
        _adminProgressOverlay = null;
    }

    // ═══════════════════════════════════════════════════════════════
    // [H] دوال مساعدة
    // ═══════════════════════════════════════════════════════════════

    function _peLog(msg) {
        console.log('[PE v' + PE_VERSION + '] ' + msg);
    }

    function _yieldUI() {
        return new Promise(function(r) { setTimeout(r, 0); });
    }

    function _escHtml(t) {
        if (!t) return '';
        return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(2) + ' MB';
    }

    function _downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
    }

    /**
     * تنتظر حتى يصبح window.db جاهزاً (مهيّأ من الكود الأصلي).
     * @param {number} timeoutMs — مهلة الانتظار بالميلي ثانية
     */
    /**
     * يُعيد كائن db الصالح للاستخدام.
     * يبحث بالترتيب: window.db ← Dexie مفتوحة بنفس الاسم.
     * يُعرِّض النتيجة على window.db لتوحيد المرجع في بقية الكود.
     */
    function _resolveDb() {
        // [1] window.db موجود ومفتوح
        if (window.db && typeof window.db.appeals !== 'undefined') {
            return window.db;
        }
        // [2] db مُعرَّف بـ let داخل script — لا يظهر على window مباشرةً،
        //     لكن Dexie تحتفظ بمرجع للنسخ المفتوحة.
        //     نحاول فتح نفس قاعدة البيانات بنفس الاسم (Dexie تُرجع النسخة الموجودة).
        try {
            var instances = Dexie && Dexie.getDatabaseNames ? null : null; // غير مفيد هنا
            // طريقة بديلة: نتحقق من المتغيرات العالمية المعروفة
            // NiabaAppealsDB_v6 هو الاسم الثابت في index.html
        } catch(e) {}
        return null;
    }

    /**
     * تنتظر حتى يصبح db جاهزاً.
     * تبحث في window.db أولاً، ثم تفتح Dexie مباشرةً كـ fallback.
     * @param {number} timeoutMs — مهلة الانتظار بالميلي ثانية
     */
    function _waitForDb(timeoutMs) {
        return new Promise(function(resolve) {
            var elapsed = 0;
            var interval = 200;
            var PE_DB_NAME = 'NiabaAppealsDB_v6'; // نفس الاسم في index.html

            function check() {
                // [1] window.db جاهز
                if (window.db && typeof window.db.appeals !== 'undefined') {
                    resolve(window.db);
                    return;
                }
                elapsed += interval;
                if (elapsed < timeoutMs) {
                    setTimeout(check, interval);
                    return;
                }
                // [2] Fallback: فتح Dexie مباشرةً بنفس اسم القاعدة
                _peLog('⚠️ window.db غير موجود — محاولة فتح Dexie مباشرةً: ' + PE_DB_NAME);
                try {
                    var fallbackDb = new Dexie(PE_DB_NAME);
                    fallbackDb.version(1).stores({
                        appeals: '++id,fileName,folder,docType,fileType,crimeType,uploadDate,appealNumber,isIndexed'
                    });
                    fallbackDb.version(2).stores({
                        appeals: '++id,fileName,folder,docType,fileType,crimeType,uploadDate,appealNumber,isIndexed',
                        backups: '++id,date',
                        metadata: 'key'
                    });
                    fallbackDb.open().then(function() {
                        window.db = fallbackDb; // نُعرِّضه على window للاستخدام المشترك
                        _peLog('✅ Dexie fallback مفتوح بنجاح');
                        resolve(fallbackDb);
                    }).catch(function(e) {
                        console.error('[PE] فشل فتح Dexie fallback:', e);
                        resolve(null);
                    });
                } catch(e) {
                    console.error('[PE] Dexie غير متوفر:', e);
                    resolve(null);
                }
            }
            check();
        });
    }

    /**
     * ينتظر تسجيل الدخول وتهيئة db ثم يبدأ الحقن.
     * يستمر في الانتظار بلا حد زمني — لأن db لا يُنشأ إلا بعد login.
     */
    function _waitForDbReady() {
        var checked = 0;
        var interval = 300;
        var PE_DB_NAME = 'NiabaAppealsDB_v6';

        function check() {
            checked++;

            // [A] window.db جاهز
            if (window.db && typeof window.db.appeals !== 'undefined') {
                _peLog('✅ window.db جاهز بعد ' + (checked * interval / 1000).toFixed(1) + 'ث — بدء الحقن');
                injectPortableDB().catch(function(e) {
                    console.error('[PE] فشل الحقن:', e);
                    _hideInjectionProgress();
                });
                return;
            }

            // [B] تسجيل الدخول تم (mainContent ظاهر) لكن db لم يُعرَّض على window
            //     → افتح Dexie مباشرةً كـ fallback
            var mainVisible = (function() {
                var el = document.getElementById('mainContent');
                return el && el.style.display !== 'none' && el.style.display !== '';
            })();

            if (mainVisible) {
                _peLog('🔓 تم تسجيل الدخول — فتح Dexie مباشرةً كـ fallback');
                try {
                    var fallbackDb = new Dexie(PE_DB_NAME);
                    fallbackDb.version(1).stores({
                        appeals: '++id,fileName,folder,docType,fileType,crimeType,uploadDate,appealNumber,isIndexed'
                    });
                    fallbackDb.version(2).stores({
                        appeals: '++id,fileName,folder,docType,fileType,crimeType,uploadDate,appealNumber,isIndexed',
                        backups: '++id,date',
                        metadata: 'key'
                    });
                    fallbackDb.open().then(function() {
                        window.db = fallbackDb;
                        _peLog('✅ Dexie fallback مفتوح — بدء الحقن');
                        injectPortableDB().catch(function(e) {
                            console.error('[PE] فشل الحقن:', e);
                            _hideInjectionProgress();
                        });
                    }).catch(function(e) {
                        _peLog('❌ فشل فتح Dexie fallback: ' + e.message + ' — إعادة المحاولة...');
                        setTimeout(check, 500);
                    });
                } catch(e) {
                    _peLog('❌ Dexie غير متوفر — إعادة المحاولة...');
                    setTimeout(check, 500);
                }
                return;
            }

            // [C] لم يتم تسجيل الدخول بعد — استمر في الانتظار
            if (checked % 50 === 0) {
                _peLog('⏳ انتظار تسجيل الدخول... (' + (checked * interval / 1000).toFixed(0) + 'ث)');
            }
            setTimeout(check, interval);
        }

        setTimeout(check, 400);
    }

    /**
     * إزالة Blobs وBase64 من السجل للتوزيع (الملفات ستُفتح من مجلد files/).
     */
    function _stripBlobFromRecord(r) {
        return {
            id:                     r.id,
            fileName:               r.fileName,
            folder:                 r.folder,
            docType:                r.docType,
            fileType:               r.fileType,
            crimeType:              r.crimeType,
            crimeLabels:            r.crimeLabels        || [],
            crimeTags:              r.crimeTags          || [],
            virtualFolders:         r.virtualFolders     || [],
            folderPaths:            r.folderPaths        || [],
            autoSummary:            r.autoSummary        || '',
            aiConfidence:           r.aiConfidence       || 0,
            autoClassifierVersion:  r.autoClassifierVersion || 0,
            content:                r.content            || '',
            isIndexed:              r.isIndexed,
            uploadDate:             r.uploadDate,
            notes:                  r.notes              || '',
            appealNumber:           r.appealNumber       || '',
            fileMime:               r.fileMime           || null,
            // هام: نحفظ نوع الملف لكن نحذف المحتوى الثنائي
            fileBase64:             null,
            fileBlob:               undefined,
            _hasFile:               !!(r.fileBase64 || r.fileBlob), // علامة: الملف موجود في مجلد files/
            _hasContent:            !!(r.content && r.content.length > 0)
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // [I] نقطة الدخول الرئيسية
    // ═══════════════════════════════════════════════════════════════

    /**
     * تشغيل محرك التوزيع بعد اكتمال تحميل الصفحة.
     */
    function init() {
        _peLog('🚀 تشغيل محرك التوزيع المحمول v' + PE_VERSION);
        _peLog('📡 وضع التشغيل: ' + (isPortableMode() ? 'توزيع محمول (db-data.js موجود)' : 'تطوير عادي'));
        _peLog('🌐 البروتوكول: ' + window.location.protocol);

        // انتظر اكتمال تهيئة النظام الأصلي ثم أضف الأزرار
        var installAttempts = 0;
        var installTimer = setInterval(function() {
            installAttempts++;
            if (document.getElementById('dataManagementSection')) {
                clearInterval(installTimer);
                installPortableButtons();
            }
            if (installAttempts > 50) clearInterval(installTimer);
        }, 200);

        // إن كنا في وضع التوزيع — ابدأ الحقن فوراً
        if (isPortableMode()) {
            _peStartTime = Date.now();
            // انتظر حتى يُنشئ المستخدم جلسة (تسجيل دخول) ثم يُهيَّأ db
            _waitForDbReady();
        }
    }

    // ─── تعريض الـ API للاستخدام الخارجي ───
    window.PortableEngine = {
        version:            PE_VERSION,
        isPortableMode:     isPortableMode,
        adminExportDB:      adminExportDB,
        exportDeltaUpdates: exportDeltaUpdates,
        importDeltaUpdates: importDeltaUpdates,
        injectPortableDB:   injectPortableDB,
        updateStatus:       _updateStatusBadge
    };

    // ─── تشغيل عند اكتمال تحميل الصفحة ───
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // الصفحة جاهزة بالفعل
        setTimeout(init, 100);
    }

    _peLog('✅ تم تسجيل المحرك — في انتظار اكتمال تحميل الصفحة');

})();
