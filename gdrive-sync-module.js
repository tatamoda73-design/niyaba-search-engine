/* ═══════════════════════════════════════════════════════════════════════════
   [HS-GDRIVE-SYNC v1] المزامنة السحابية مع Google Drive — وحدة Drop-in مستقلة
   - مصادقة: Google Identity Services (token model) — بدون gapi وبدون خادم
   - رفع: Resumable Upload على أجزاء 8MB + ضغط gzip متدفق (لا يُبنى ملف في الذاكرة)
     يعيد استخدام HSExport.writeToWritable الموجود، فيُنتج نفس صيغة saveDatabaseToDisk
   - تنزيل: بث + فك ضغط + كتابة في قاعدة مرحلية (NiabaDriveStage) ثم استبدال appeals
     بعد اكتمال التنزيل فقط → انقطاع الشبكة لا يفقدك بياناتك المحلية
   - لا يمس الدوال الأصلية: يغلّف saveIncremental و startGiganticSystem فقط
   - بدون Client ID أو بدون اتصال → التطبيق يعمل Offline كما كان تماماً
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
if (window.HSDrive) return;

var CFG = {
    FILE_NAME: 'niaba_db_v2026.json.gz',
    FOLDER_NAME: 'موسوعة_النيابة_المزامنة',
    USE_APPDATA: false,              // true => مجلد التطبيق المخفي (drive.appdata) بدل مجلد ظاهر (drive.file)
    CHUNK: 8 * 1024 * 1024,          // مضاعف لـ 256KiB كما يشترط Drive
    AUTO_IDLE_MS: 90 * 1000,         // رفع تلقائي بعد هدوء 90 ثانية من آخر تعديل
    BOOT_QUIET_MS: 30 * 1000,        // تجاهل ضجيج الإقلاع (ترحيلات داخلية) في أول 30 ثانية
    STATE_KEY: 'hs_gdrive_state_v1',
    SCHEMA: 1
};
var SCOPE = 'https://www.googleapis.com/auth/' + (CFG.USE_APPDATA ? 'drive.appdata' : 'drive.file');
var API = 'https://www.googleapis.com/drive/v3';
var UP = 'https://www.googleapis.com/upload/drive/v3';

/* ─────────────── الحالة المحفوظة محلياً ─────────────── */
var DEFAULTS = { clientId: '', folderId: '', fileId: '', remoteMod: '', dirty: false,
                 auto: true, connected: false, everGranted: false, lastSync: 0 };
function loadState() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG.STATE_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
}
var S = loadState();
function save() { try { localStorage.setItem(CFG.STATE_KEY, JSON.stringify(S)); } catch (e) {} }

var busy = '', needReauth = false, lastError = '', started = false, bootAt = 0, quietUntil = 0;
var changeSeq = 0, autoTimer = null, armed = false, folderChecked = false, remoteInfo = null;
var token = null, tokenExp = 0, gisPromise = null;

function $(id) { return document.getElementById(id); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
function toast(m, err) { try { if (typeof window.showToast === 'function') window.showToast(m, !!err); } catch (e) {} }
function logErr(kind, msg, detail) { try { if (typeof window._v6LogError === 'function') window._v6LogError('gdrive-' + kind, msg, detail); } catch (e) {} }
function DriveErr(msg, status, reason) { var e = new Error(msg); e.status = status || 0; e.reason = reason || ''; return e; }
function fmtTime(t) { try { return new Date(t).toLocaleString('ar-EG'); } catch (e) { return String(t); } }
function fmtMB(n) { return (n / 1048576).toFixed(1) + ' MB'; }
function deviceName() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'browser';
    return (p + (/Mobi|Android/i.test(navigator.userAgent || '') ? ' (mobile)' : '')).slice(0, 60);
}

/* ─────────────── الأخطاء → رسائل مفهومة ─────────────── */
function friendly(status, reason, msg) {
    if (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded')
        return 'مساحة Google Drive ممتلئة — حرّر مساحة أو زِد السعة ثم أعد الرفع';
    if (status === 401) return 'انتهت صلاحية تسجيل الدخول — أعد الاتصال بـ Google Drive';
    if (status === 403 && /rateLimit|dailyLimit|userRate/i.test(reason || ''))
        return 'تجاوزت حد الطلبات المؤقت لدى Google — أعد المحاولة بعد قليل';
    if (status === 403) return 'رفضت Google الصلاحية (' + (reason || msg || '403') + ')';
    if (status === 404) return 'الملف أو الجلسة غير موجودة على Drive';
    return 'خطأ من Drive (' + status + '): ' + (msg || reason || '');
}
async function toErr(r) {
    var reason = '', msg = '';
    try { var j = await r.json(); var er = j && j.error; if (er) { msg = er.message || ''; reason = (er.errors && er.errors[0] && er.errors[0].reason) || er.status || ''; } } catch (e) {}
    return DriveErr(friendly(r.status, reason, msg), r.status, reason);
}

/* ─────────────── المصادقة (GIS) ─────────────── */
function loadGIS() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (res, rej) {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) return res();
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
        s.onload = function () { res(); };
        s.onerror = function () { rej(DriveErr('تعذر تحميل مكتبة Google — تحقق من الإنترنت', 0, 'gis_load')); };
        document.head.appendChild(s);
    });
    gisPromise.catch(function () { gisPromise = null; });
    return gisPromise;
}
function requestToken(prompt) {
    return loadGIS().then(function () {
        return new Promise(function (res, rej) {
            var timer = setTimeout(function () { rej(DriveErr('لم تكتمل نافذة تسجيل الدخول', 0, 'timeout')); }, 120000);
            var tc = window.google.accounts.oauth2.initTokenClient({
                client_id: S.clientId, scope: SCOPE,
                callback: function (r) {
                    clearTimeout(timer);
                    if (r.error) return rej(DriveErr('فشل تسجيل الدخول: ' + (r.error_description || r.error), 401, r.error));
                    token = r.access_token; tokenExp = Date.now() + Math.max(60, (r.expires_in || 3600) - 90) * 1000;
                    res(token);
                },
                error_callback: function (e) { clearTimeout(timer); rej(DriveErr('تعذر فتح نافذة Google (' + ((e && e.type) || 'popup') + ')', 0, (e && e.type) || 'popup')); }
            });
            tc.requestAccessToken({ prompt: prompt });
        });
    });
}
function ensureToken() {
    if (token && Date.now() < tokenExp) return Promise.resolve(token);
    if (!S.clientId) return Promise.reject(DriveErr('أدخل OAuth Client ID أولاً', 0, 'no_client'));
    if (location.protocol === 'file:') return Promise.reject(DriveErr('Google لا تقبل الصفحات المفتوحة بـ file:// — شغّل الموسوعة عبر http://localhost أو https', 0, 'file_origin'));
    return requestToken(S.everGranted ? '' : 'consent').then(function (t) { S.everGranted = true; save(); return t; });
}
async function gfetch(url, opts) {
    opts = opts || {};
    var t = await ensureToken();
    var o = Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + t }) });
    var r;
    try { r = await fetch(url, o); }
    catch (e) { throw DriveErr('تعذر الاتصال بخوادم Google — تحقق من الإنترنت', 0, 'network'); }
    if (r.status === 401 && !opts._retried) { token = null; return gfetch(url, Object.assign({}, opts, { _retried: true })); }
    if (!r.ok && r.status !== 308) throw await toErr(r);
    return r;
}

/* ─────────────── عمليات Drive ─────────────── */
function qq(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
async function ensureFolder() {
    if (CFG.USE_APPDATA) return 'appDataFolder';
    if (S.folderId && folderChecked) return S.folderId;
    if (S.folderId) {
        try {
            var r0 = await gfetch(API + '/files/' + S.folderId + '?fields=id,trashed');
            var j0 = await r0.json();
            if (!j0.trashed) { folderChecked = true; return S.folderId; }
        } catch (e) { if (e.status !== 404) throw e; }
        S.folderId = '';
    }
    var q = "mimeType='application/vnd.google-apps.folder' and name='" + qq(CFG.FOLDER_NAME) + "' and trashed=false";
    var r = await gfetch(API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1&spaces=drive');
    var j = await r.json(), id = j.files && j.files[0] && j.files[0].id;
    if (!id) {
        var c = await gfetch(API + '/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: CFG.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
        id = (await c.json()).id;
    }
    S.folderId = id; folderChecked = true; save();
    return id;
}
async function findRemote() {
    var folder = await ensureFolder();
    var q = "name='" + qq(CFG.FILE_NAME) + "' and '" + folder + "' in parents and trashed=false";
    var r = await gfetch(API + '/files?q=' + encodeURIComponent(q) + '&orderBy=modifiedTime%20desc&pageSize=1' +
        '&fields=files(id,size,modifiedTime,appProperties)&spaces=' + (CFG.USE_APPDATA ? 'appDataFolder' : 'drive'));
    var f = (await r.json()).files;
    return (f && f[0]) || null;
}
async function openSession(folder, existingId, meta) {
    var body = { name: CFG.FILE_NAME, mimeType: 'application/gzip', appProperties: meta }, url, method;
    if (existingId) { method = 'PATCH'; url = UP + '/files/' + existingId + '?uploadType=resumable&fields=id,size,modifiedTime'; }
    else { method = 'POST'; url = UP + '/files?uploadType=resumable&fields=id,size,modifiedTime'; body.parents = [folder]; }
    var r = await gfetch(url, { method: method, body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/gzip' } });
    var loc = r.headers.get('Location');
    if (!loc) throw DriveErr('لم يُرجِع Drive رابط الرفع', 0, 'no_session');
    return loc;
}

/* ─────────────── الرفع المتدفق: Sink (أجزاء) + Gzip Writable ─────────────── */
function makeSink(sessionUrl, onSent) {
    var parts = [], buffered = 0, sent = 0;
    function take(n) {
        n = Math.min(n, buffered);
        var out = new Uint8Array(n), off = 0;
        while (off < n) {
            var p = parts[0], need = n - off;
            if (p.length <= need) { out.set(p, off); off += p.length; parts.shift(); }
            else { out.set(p.subarray(0, need), off); parts[0] = p.subarray(need); off += need; }
        }
        buffered -= n; return out;
    }
    async function queryOffset() {
        try {
            var r = await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Range': 'bytes */*' } });
            if (r.status === 308) { var rg = r.headers.get('Range'); var m = rg && /-(\d+)$/.exec(rg); return m ? (+m[1] + 1) : null; }
        } catch (e) {}
        return null;
    }
    async function put(bytes, isLast) {
        var start = sent, total = isLast ? String(sent + bytes.length) : '*';
        var range = bytes.length ? 'bytes ' + start + '-' + (start + bytes.length - 1) + '/' + total : 'bytes */' + total;
        for (var attempt = 0; ; attempt++) {
            var r;
            try { r = await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Range': range }, body: bytes }); }
            catch (e) {
                if (attempt >= 4) throw DriveErr('انقطع الاتصال أثناء الرفع — أعد المحاولة', 0, 'network');
                await sleep(1500 * (attempt + 1));
                var off = await queryOffset();
                if (!isLast && off === start + bytes.length) { sent += bytes.length; if (onSent) onSent(sent); return null; }
                continue;
            }
            if (r.status === 308) { sent += bytes.length; if (onSent) onSent(sent); return null; }
            if (r.status === 200 || r.status === 201) { sent += bytes.length; if (onSent) onSent(sent); return r.json(); }
            if (r.status >= 500 && attempt < 4) { await sleep(1500 * (attempt + 1)); continue; }
            throw await toErr(r);
        }
    }
    return {
        push: async function (u8) {
            parts.push(u8); buffered += u8.length;
            while (buffered >= CFG.CHUNK) await put(take(CFG.CHUNK), false);
        },
        finish: async function () { return put(take(buffered), true); },
        sent: function () { return sent; }
    };
}
function makeGzipWritable(sink) {
    var cs = new CompressionStream('gzip'), w = cs.writable.getWriter(), enc = new TextEncoder(), pumpErr = null;
    var pump = (async function () {
        var rd = cs.readable.getReader();
        try { for (;;) { var x = await rd.read(); if (x.done) break; await sink.push(x.value); } }
        catch (e) { pumpErr = e; try { await rd.cancel(e); } catch (_) {} throw e; }
    })();
    pump.catch(function () {});
    return {
        write: async function (s) { if (pumpErr) throw pumpErr; await w.write(enc.encode(s)); },
        close: async function () { await w.close(); await pump; return sink.finish(); },
        abort: async function () { try { await w.abort(); } catch (e) {} }
    };
}

/* ─────────────── شريط التقدم (يربط الأصلي + لوحة المزامنة) ─────────────── */
function setProg(p, txt) {
    p = Math.max(0, Math.min(100, p));
    var f = $('hsgdFill'); if (f) f.style.width = p + '%';
    var t = $('hsgdProgTxt'); if (t) t.textContent = txt || '';
    var ep = $('exportProgress'), ef = $('exportProgressFill'), et = $('exportProgressText');
    if (ep) ep.style.display = 'block';
    if (ef) ef.style.width = p + '%';
    if (et) et.innerText = '☁️ ' + (txt || '');
    var top = $('hs2026TopProgress');
    if (top) { top.className = ''; var b = top.querySelector('.hs-prog-bar'); if (b) b.style.width = p + '%'; }
}
function endProg() {
    var top = $('hs2026TopProgress');
    if (top) { top.className = 'done'; setTimeout(function () { var b = top.querySelector('.hs-prog-bar'); if (b) b.style.width = '0%'; top.className = ''; }, 400); }
    setTimeout(function () {
        var ep = $('exportProgress'), ef = $('exportProgressFill'), f = $('hsgdFill'), t = $('hsgdProgTxt');
        if (ep) ep.style.display = 'none'; if (ef) ef.style.width = '0%'; if (f) f.style.width = '0%'; if (t) t.textContent = '';
    }, 1800);
}
function handleErr(e, kind) {
    var msg = (e && e.message) || String(e);
    lastError = msg; logErr(kind || 'error', msg, (e && e.stack) || '');
    if (e && (e.status === 401 || e.reason === 'popup' || e.reason === 'popup_failed_to_open' || e.reason === 'timeout')) { needReauth = true; armGesture(); }
    toast('☁️ ' + msg, true); render();
}

/* كتابة السجلات كاملة (كل الحقول ما عدا fileBlob غير القابل للتسلسل) — HSExport.mapRecord يُسقط
   filePath/_portablePath/_hasFile/_hasContent فيتعطل فتح الملفات الأصلية من files/ بعد الاستعادة */
async function writeAllRecords(w, onProgress) {
    await w.write('[\n');
    var first = true, count = 0;
    await window.HSExport.forEachBatch(async function (rows, done, total) {
        var buf = [];
        for (var k = 0; k < rows.length; k++) { var r = Object.assign({}, rows[k]); delete r.fileBlob; buf.push(JSON.stringify(r)); count++; }
        await w.write((first ? '' : ',\n') + buf.join(',\n'));
        first = false;
        if (onProgress) onProgress(done, total);
    });
    await w.write('\n]');
    return count;
}

/* ─────────────── الرفع الكامل ─────────────── */
async function pushNow() {
    if (busy) return false;
    busy = 'push'; lastError = ''; render();
    try {
        if (navigator.onLine === false) throw DriveErr('لا يوجد اتصال بالإنترنت', 0, 'offline');
        if (!window.db || !window.HSExport) throw DriveErr('قاعدة البيانات غير جاهزة بعد', 0, 'not_ready');
        if (typeof CompressionStream === 'undefined') throw DriveErr('المتصفح لا يدعم الضغط المتدفق — حدّث Chrome/Edge/Safari', 0, 'no_gzip');
        var count = await window.db.appeals.count();
        if (!count) throw DriveErr('قاعدة البيانات المحلية فارغة — لن أرفعها فوق نسخة Drive', 0, 'empty');
        var folder = await ensureFolder();
        var mark = changeSeq;
        var meta = { schema: String(CFG.SCHEMA), count: String(count), savedAt: new Date().toISOString(), device: deviceName() };
        var session;
        try { session = await openSession(folder, S.fileId, meta); }
        catch (e) { if (e.status === 404 && S.fileId) { S.fileId = ''; session = await openSession(folder, '', meta); } else throw e; }
        setProg(2, 'بدء الرفع إلى Drive…');
        var gz = makeGzipWritable(makeSink(session)), res;
        try {
            await writeAllRecords(gz, function (d, t) { setProg(2 + (d / t) * 93, 'رفع ' + d + ' / ' + t + ' سجل'); });
            res = await gz.close();
        } catch (e) { await gz.abort(); throw e; }
        if (!res || !res.id) throw DriveErr('انتهى الرفع دون تأكيد من Drive', 0, 'no_result');
        S.fileId = res.id; S.remoteMod = res.modifiedTime; S.lastSync = Date.now();
        S.dirty = (changeSeq !== mark); save();
        remoteInfo = { size: +res.size || 0, modifiedTime: res.modifiedTime, appProperties: meta };
        setProg(100, 'تم الرفع ✓ (' + fmtMB(+res.size || 0) + ' مضغوط)');
        toast('☁️ تم رفع ' + count + ' سجل إلى Google Drive');
        if (S.dirty) scheduleAuto();
        return true;
    } catch (e) { handleErr(e, 'push'); return false; }
    finally { busy = ''; endProg(); render(); }
}

/* ─────────────── التنزيل الآمن (مرحلة وسيطة ثم استبدال) ─────────────── */
async function applyStage(stage) {
    var keys = await stage.rows.toCollection().primaryKeys();
    await window.db.appeals.clear();
    for (var i = 0; i < keys.length; i += 40) {
        var rows = (await stage.rows.bulkGet(keys.slice(i, i + 40))).filter(Boolean);
        rows.forEach(function (r) { delete r.k; });
        await window.db.appeals.bulkAdd(rows);
        setProg(72 + (i / keys.length) * 26, 'تطبيق ' + Math.min(i + 40, keys.length) + ' / ' + keys.length);
        await tick();
    }
    return keys.length;
}
async function pullNow(remote) {
    if (busy) return false;
    busy = 'pull'; lastError = ''; render();
    var stage = null, phase = 'download';
    try {
        if (navigator.onLine === false) throw DriveErr('لا يوجد اتصال بالإنترنت', 0, 'offline');
        if (!window.db) throw DriveErr('قاعدة البيانات غير جاهزة بعد', 0, 'not_ready');
        if (typeof DecompressionStream === 'undefined') throw DriveErr('المتصفح لا يدعم فك الضغط المتدفق — حدّث المتصفح', 0, 'no_gzip');
        remote = remote || await findRemote();
        if (!remote) throw DriveErr('لا توجد نسخة على Drive بعد', 404, 'none');
        var size = +remote.size || 1, got = 0;
        var r = await gfetch(API + '/files/' + remote.id + '?alt=media');
        stage = new Dexie('NiabaDriveStage'); stage.version(1).stores({ rows: '++k' });
        await stage.rows.clear();
        var text = r.body
            .pipeThrough(new TransformStream({ transform: function (c, ctl) { got += c.length; setProg(Math.min(70, (got / size) * 70), 'تنزيل ' + fmtMB(got) + ' / ' + fmtMB(size)); ctl.enqueue(c); } }))
            .pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
        var rd = text.getReader(), tail = '', batch = [], bchars = 0, staged = 0;
        var flush = async function () { if (batch.length) { await stage.rows.bulkAdd(batch); staged += batch.length; batch = []; bchars = 0; } };
        var handle = async function (line) {
            line = line.trim();
            if (!line || line === '[' || line === ']') return;
            if (line.charAt(line.length - 1) === ',') line = line.slice(0, -1);
            if (line.charAt(0) === '[') line = line.slice(1);
            if (line.charAt(line.length - 1) === ']') line = line.slice(0, -1);
            if (!line) return;
            var rec = JSON.parse(line); delete rec.id; batch.push(rec);
            bchars += (rec.content ? rec.content.length : 0) + (rec.fileBase64 ? rec.fileBase64.length : 0) + 500;
            if (batch.length >= 50 || bchars > 16e6) await flush();
        };
        for (;;) {
            var x = await rd.read(); if (x.done) break;
            var parts = (tail + x.value).split('\n'); tail = parts.pop();
            for (var i = 0; i < parts.length; i++) await handle(parts[i]);
        }
        await handle(tail); await flush();
        if (!staged) throw DriveErr('نسخة Drive لا تحتوي سجلات — لم يتم تغيير بياناتك المحلية', 0, 'empty_remote');
        setProg(72, 'اكتمل التنزيل — جاري التطبيق على القاعدة المحلية…');
        var applied; phase = 'apply';
        try { applied = await applyStage(stage); }
        catch (e1) { logErr('apply-retry', e1.message, e1.stack); applied = await applyStage(stage); }
        S.remoteMod = remote.modifiedTime; S.fileId = remote.id; S.dirty = false; S.lastSync = Date.now(); save();
        quietUntil = Date.now() + 20000;
        try { if (typeof window.loadEssentialData === 'function') await window.loadEssentialData(); } catch (e2) { logErr('refresh', e2.message, e2.stack); }
        try {
            if (typeof window.rebuildHyperIndexAsync === 'function')
                window.rebuildHyperIndexAsync().then(function () { if (window.saveFlexSearchIndex) return window.saveFlexSearchIndex(); }).catch(function () {});
        } catch (e3) {}
        setProg(100, 'تم تحميل ' + applied + ' سجل ✓');
        toast('☁️ تم تحميل ' + applied + ' سجل من Google Drive');
        return true;
    } catch (e) {
        if (!e.reason) e = phase === 'download'
            ? DriveErr('انقطع التنزيل أو الملف تالف — بياناتك المحلية لم تتغير', 0, 'stream')
            : DriveErr('فشل تطبيق نسخة Drive على القاعدة المحلية: ' + e.message, 0, 'apply');
        handleErr(e, 'pull'); return false;
    }
    finally {
        if (stage) { try { await stage.delete(); } catch (e) {} }
        busy = ''; endProg(); render();
    }
}

/* ─────────────── المصالحة عند الإقلاع / بعد الاتصال ─────────────── */
function askChoice(remote, count) {
    return new Promise(function (res) {
        var ap = remote.appProperties || {};
        var ov = document.createElement('div'); ov.className = 'hsgd-ov'; ov.style.display = 'flex';
        var box = document.createElement('div'); box.className = 'hsgd-box'; box.setAttribute('dir', 'rtl'); ov.appendChild(box);
        var h = document.createElement('div'); h.className = 'hsgd-h'; h.textContent = '☁️ نسختان مختلفتان — اختر المصدر الصحيح'; box.appendChild(h);
        var p = document.createElement('div'); p.className = 'hsgd-info';
        p.textContent = 'على هذا الجهاز: ' + count + ' سجل.\nعلى Drive: ' + (ap.count || '؟') + ' سجل — حُفظت ' +
            (ap.savedAt ? fmtTime(ap.savedAt) : fmtTime(remote.modifiedTime)) + (ap.device ? ' من (' + ap.device + ')' : '') +
            '.\nأي اختيار يستبدل الطرف الآخر بالكامل (ليس دمجاً).';
        p.style.whiteSpace = 'pre-line'; box.appendChild(p);
        var row = document.createElement('div'); row.className = 'hsgd-row'; box.appendChild(row);
        [['pull', '⬇️ استخدم نسخة Drive (يستبدل المحلي)', 'btn btn-gold btn-sm'],
         ['push', '⬆️ ارفع المحلي (يستبدل Drive)', 'btn btn-outline btn-sm'],
         ['skip', 'لاحقاً', 'btn btn-outline btn-sm']].forEach(function (b) {
            var bt = document.createElement('button'); bt.className = b[2]; bt.textContent = b[1];
            bt.onclick = function () { ov.remove(); res(b[0]); }; row.appendChild(bt);
        });
        document.body.appendChild(ov);
    });
}
async function reconcile() {
    if (busy) return;
    try {
        var remote = await findRemote(), count = await window.db.appeals.count();
        remoteInfo = remote ? { size: +remote.size || 0, modifiedTime: remote.modifiedTime, appProperties: remote.appProperties || {} } : null;
        render();
        if (!remote) { if (count > 0 && S.auto) await pushNow(); return; }
        if (count === 0) { await pullNow(remote); return; }      // جهاز جديد/قاعدة فارغة → استرجاع دائماً
        if (remote.modifiedTime === S.remoteMod) { if (S.dirty && S.auto) await pushNow(); return; }
        if (S.remoteMod && !S.dirty) { await pullNow(remote); return; }
        var c = await askChoice(remote, count);
        if (c === 'pull') await pullNow(remote); else if (c === 'push') await pushNow();
    } catch (e) { handleErr(e, 'reconcile'); }
}

/* ─────────────── تتبّع التعديلات + الرفع التلقائي ─────────────── */
function noteChange() {
    if (busy === 'pull' || Date.now() < quietUntil || (bootAt && Date.now() - bootAt < CFG.BOOT_QUIET_MS)) return;
    changeSeq++;
    if (!S.dirty) { S.dirty = true; save(); }
    render(); scheduleAuto();
}
function scheduleAuto() {
    if (!S.auto || !S.connected || !S.clientId || location.protocol === 'file:') return;
    clearTimeout(autoTimer); autoTimer = setTimeout(autoRun, CFG.AUTO_IDLE_MS);
}
async function autoRun() {
    if (busy) return scheduleAuto();
    if (!S.dirty || !S.connected) return;
    if (navigator.onLine === false) return scheduleAuto();
    if (!token || Date.now() >= tokenExp) {
        try { await ensureToken(); needReauth = false; } catch (e) { needReauth = true; armGesture(); render(); return; }
    }
    await pushNow();
}
function armGesture() {
    if (armed || !S.connected) return;
    armed = true;
    var h = function () {
        document.removeEventListener('click', h, true); armed = false;
        ensureToken().then(function () { needReauth = false; render(); if (!busy) reconcile(); })
            .catch(function () { needReauth = true; render(); });
    };
    document.addEventListener('click', h, true);
}

/* ─────────────── الاتصال / القطع ─────────────── */
async function connect() {
    if (location.protocol === 'file:') { toast('☁️ Google لا تقبل file:// — شغّل الموسوعة عبر http://localhost أو https', true); render(); return; }
    if (!S.clientId) { toast('☁️ أدخل OAuth Client ID أولاً', true); return; }
    try {
        await ensureToken();
        S.connected = true; S.everGranted = true; needReauth = false; lastError = ''; save(); render();
        toast('☁️ تم الاتصال بـ Google Drive');
        await reconcile();
    } catch (e) { handleErr(e, 'auth'); }
}
function disconnect() {
    try { if (token && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(token, function () {}); } catch (e) {}
    token = null; tokenExp = 0; S.connected = false; S.everGranted = false; needReauth = false; clearTimeout(autoTimer); save(); render();
    toast('☁️ تم قطع الاتصال (بياناتك المحلية وملف Drive لم يتأثرا)');
}

/* ─────────────── الإقلاع ─────────────── */
async function startup() {
    if (started) return; started = true;
    render();
    if (!S.clientId || !S.connected || location.protocol === 'file:') return;
    loadGIS().catch(function () {});
    try { await requestToken(''); needReauth = false; }
    catch (e) { needReauth = true; armGesture(); render(); return; }
    await reconcile();
}

/* ─────────────── الواجهة ─────────────── */
function statusText() {
    if (location.protocol === 'file:') return { t: 'يلزم localhost', c: '#e67e22' };
    if (!S.clientId) return { t: 'غير مُعدّ', c: '#8896a5' };
    if (!S.connected) return { t: 'غير متصل', c: '#8896a5' };
    if (busy === 'push') return { t: 'جارٍ الرفع…', c: '#2980b9' };
    if (busy === 'pull') return { t: 'جارٍ التنزيل…', c: '#2980b9' };
    if (needReauth) return { t: 'أعد الاتصال (نقرة)', c: '#e67e22' };
    if (lastError) return { t: 'خطأ — راجع اللوحة', c: '#e74c3c' };
    if (S.dirty) return { t: 'تغييرات غير مرفوعة', c: '#e67e22' };
    return { t: 'متزامن ✓' + (S.lastSync ? ' ' + new Date(S.lastSync).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : ''), c: '#27ae60' };
}
function render() {
    var st = statusText();
    var lbl = $('hsgdBtnLbl'); if (lbl) { lbl.textContent = 'Drive: ' + st.t; lbl.style.color = st.c; }
    if (!$('hsgdPanel')) return;
    var w = $('hsgdWarn');
    if (w) { w.style.display = location.protocol === 'file:' ? 'block' : 'none';
        w.textContent = '⚠️ الصفحة مفتوحة بـ file:// — Google OAuth لا يعمل منها. شغّل الموسوعة عبر خادم محلي (مثل: python -m http.server 8080 ثم http://localhost:8080) أو على https، وأضف هذا العنوان في Authorized JavaScript origins.'; }
    $('hsgdConn').textContent = S.connected ? (needReauth ? '🔑 أعد الاتصال' : '🔌 قطع الاتصال') : '🔑 اتصال بـ Google Drive';
    $('hsgdPush').disabled = !S.connected || !!busy; $('hsgdPull').disabled = !S.connected || !!busy; $('hsgdChk').disabled = !S.connected || !!busy;
    $('hsgdAuto').checked = !!S.auto;
    var cid = $('hsgdCid'); if (cid && document.activeElement !== cid && !cid.value) cid.value = S.clientId || '';
    $('hsgdState').textContent = 'الحالة: ' + st.t + (S.lastSync ? ' — آخر مزامنة: ' + fmtTime(S.lastSync) : '') + (CFG.USE_APPDATA ? ' — (مجلد التطبيق المخفي)' : ' — المجلد: ' + CFG.FOLDER_NAME);
    var ap = (remoteInfo && remoteInfo.appProperties) || {};
    $('hsgdInfo').textContent = remoteInfo ? 'نسخة Drive: ' + (ap.count || '؟') + ' سجل — ' + fmtMB(remoteInfo.size) + ' — ' + fmtTime(remoteInfo.modifiedTime) + (ap.device ? ' — ' + ap.device : '') : '';
    $('hsgdErr').textContent = lastError ? '⚠️ ' + lastError : '';
}
function buildPanel() {
    if ($('hsgdPanel')) return;
    var css = document.createElement('style');
    css.textContent = '.hsgd-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:1rem}' +
        '.hsgd-box{background:var(--card-bg,#fff);color:var(--text-dark,#1e2d3d);border:1px solid var(--gold,#c49a1b);border-radius:14px;padding:1.1rem 1.3rem;max-width:560px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.4);text-align:right}' +
        '.hsgd-h{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:.8rem;font-size:1.05rem}' +
        '.hsgd-x{background:none;border:0;font-size:1.2rem;cursor:pointer;color:inherit}' +
        '.hsgd-row{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0}.hsgd-row input{flex:1;min-width:200px;padding:.45rem;border:1px solid var(--border-light,#ccc);border-radius:8px;background:transparent;color:inherit}' +
        '.hsgd-warn{background:#fff3cd;color:#664d03;border-radius:8px;padding:.6rem;margin:.5rem 0;font-size:.85rem}' +
        '.hsgd-info,.hsgd-st,.hsgd-pt{font-size:.82rem;color:var(--text-muted,#5d6f83);margin:.35rem 0}.hsgd-err{font-size:.85rem;color:#e74c3c;margin:.35rem 0}' +
        '.hsgd-bar{height:8px;background:var(--border-light,#e4e8ef);border-radius:6px;overflow:hidden;margin-top:.6rem}#hsgdFill{height:100%;width:0;background:var(--gold,#c49a1b);transition:width .25s}' +
        '.hsgd-chk{display:flex;gap:.4rem;align-items:center;font-size:.85rem;margin:.4rem 0}';
    document.head.appendChild(css);
    var ov = document.createElement('div'); ov.id = 'hsgdPanel'; ov.className = 'hsgd-ov'; ov.style.display = 'none';
    ov.innerHTML = '<div class="hsgd-box" dir="rtl"><div class="hsgd-h"><span>☁️ المزامنة السحابية — Google Drive</span><button class="hsgd-x" id="hsgdX">✕</button></div>' +
        '<div class="hsgd-warn" id="hsgdWarn" style="display:none"></div>' +
        '<div style="font-size:.85rem">OAuth Client ID (من Google Cloud Console)</div>' +
        '<div class="hsgd-row"><input id="hsgdCid" dir="ltr" placeholder="xxxxxxxx.apps.googleusercontent.com"><button class="btn btn-outline btn-sm" id="hsgdSaveCid">حفظ</button></div>' +
        '<div class="hsgd-row"><button class="btn btn-gold btn-sm" id="hsgdConn"></button><button class="btn btn-outline btn-sm" id="hsgdPush">⬆️ رفع الآن</button>' +
        '<button class="btn btn-outline btn-sm" id="hsgdPull">⬇️ تنزيل من Drive</button><button class="btn btn-outline btn-sm" id="hsgdChk">🔄 فحص Drive</button></div>' +
        '<label class="hsgd-chk"><input type="checkbox" id="hsgdAuto"> رفع تلقائي بعد 90 ثانية من آخر تعديل</label>' +
        '<div class="hsgd-st" id="hsgdState"></div><div class="hsgd-info" id="hsgdInfo"></div>' +
        '<div class="hsgd-bar"><div id="hsgdFill"></div></div><div class="hsgd-pt" id="hsgdProgTxt"></div><div class="hsgd-err" id="hsgdErr"></div></div>';
    document.body.appendChild(ov);
    $('hsgdX').onclick = function () { ov.style.display = 'none'; };
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
    $('hsgdSaveCid').onclick = function () {
        var v = $('hsgdCid').value.trim();
        if (v && !/\.apps\.googleusercontent\.com$/.test(v)) { toast('☁️ صيغة Client ID غير صحيحة', true); return; }
        S.clientId = v; token = null; tokenExp = 0; save(); toast('☁️ تم حفظ Client ID'); render();
    };
    $('hsgdConn').onclick = function () { if (S.connected && !needReauth) disconnect(); else connect(); };
    $('hsgdPush').onclick = function () { pushNow(); };
    $('hsgdPull').onclick = async function () {
        var n = 0; try { n = await window.db.appeals.count(); } catch (e) {}
        if (n && !confirm('سيُستبدل كل المحتوى المحلي (' + n + ' سجل) بنسخة Drive. متابعة؟')) return;
        pullNow();
    };
    $('hsgdChk').onclick = function () { reconcile(); };
    $('hsgdAuto').onchange = function () { S.auto = this.checked; save(); if (S.auto && S.dirty) scheduleAuto(); };
}
function openPanel() { buildPanel(); $('hsgdPanel').style.display = 'flex'; loadGIS().catch(function () {}); render(); }
function installButton() {
    var grid = $('mawso3aSettingsGrid');
    if (!grid || $('hsgdBtn')) return !!$('hsgdBtn');
    var b = document.createElement('button');
    b.id = 'hsgdBtn'; b.className = 'btn btn-outline'; b.title = 'مزامنة قاعدة البيانات مع Google Drive';
    b.innerHTML = '<i class="fas fa-cloud"></i> <span id="hsgdBtnLbl">Drive</span>';
    b.onclick = openPanel; grid.appendChild(b); render();
    return true;
}

/* ─────────────── ربط غير مُتلِف بالدوال الأصلية ─────────────── */
(function hook() {
    var s = window.saveIncremental;
    if (typeof s === 'function' && !s.__gd) {
        var w = function () { try { noteChange(); } catch (e) {} return s.apply(this, arguments); };
        w.__gd = true; window.saveIncremental = w;
    }
    var prev = window.startGiganticSystem;
    if (typeof prev === 'function' && !prev.__gd) {
        var ws = async function () {
            var r = await prev.apply(this, arguments);
            bootAt = Date.now();
            try { installButton(); startup(); } catch (e) { logErr('boot', e.message, e.stack); }
            return r;
        };
        ws.__gd = true; window.startGiganticSystem = ws;
    }
    try { installButton(); } catch (e) {}
    var n = 0, iv = setInterval(function () { if (installButton() || ++n > 40) clearInterval(iv); }, 500);
    window.addEventListener('online', function () { if (S.connected && S.dirty) scheduleAuto(); });
})();

window.HSDrive = { connect: connect, disconnect: disconnect, pushNow: pushNow, pullNow: pullNow, reconcile: reconcile,
    openPanel: openPanel, config: CFG, state: function () { return Object.assign({}, S); },
    _t: { makeSink: makeSink, makeGzipWritable: makeGzipWritable } };
console.log('[HS-GDRIVE-SYNC] جاهز — ' + (S.clientId ? 'Client ID محفوظ' : 'بانتظار Client ID'));
})();
