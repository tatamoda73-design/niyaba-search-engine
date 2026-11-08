/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  opfs-worker.js — تخزين OPFS الدائم للملفات الثنائية               ║
 * ║  موسوعة نيابة النقض الجنائي — Enterprise v2026 ULTRA               ║
 * ║  المؤلف: حسني صفوت عبد المجيد                                       ║
 * ║  © 2026 — جميع الحقوق محفوظة                                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 *  OPFS = Origin Private File System
 *  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  • تخزين دائم حقيقي — لا يُمسح عند إغلاق المتصفح أبداً
 *  • Binary مباشر — لا Base64، لا تضخيم 33%
 *  • Web Worker منفصل — لا يُعيق الـ main thread لحظة واحدة
 *  • 5-10x أسرع من fileBase64 في IndexedDB
 *  • يعمل على Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+
 *
 *  ─── بروتوكول الرسائل (postMessage) ─────────────────────────
 *
 *  الرسائل الواردة (main → worker):
 *  { op:'write', id, fileName, folder, mime, buffer: ArrayBuffer }
 *  { op:'read',  id }
 *  { op:'delete',id }
 *  { op:'exists',id }
 *  { op:'list' }
 *  { op:'writeMany', items:[{id,fileName,folder,mime,buffer}] }  ← دفعة
 *  { op:'deleteMany', ids:[] }
 *  { op:'migrate', records:[{id,fileBase64,fileMime,fileType}] } ← ترقية قديم
 *  { op:'stats' }
 *  { op:'ping' }
 *
 *  الرسائل الصادرة (worker → main):
 *  { op, id, ok:true }
 *  { op, id, ok:false, error:string }
 *  { op:'read', id, ok:true, buffer:ArrayBuffer, mime:string }
 *  { op:'list', ok:true, keys:[string] }
 *  { op:'writeMany', ok:true, written:N, errors:[] }
 *  { op:'migrate', ok:true, migrated:N }
 *  { op:'stats', ok:true, fileCount:N, totalBytes:N }
 *  { op:'progress', written:N, total:N }    ← تقدم الدفعة
 *
 *  ─── هيكل التخزين داخل OPFS ─────────────────────────────────
 *
 *   /niaba_files/
 *   └── {id}.bin          ← بيانات الملف الثنائية
 *   /niaba_meta/
 *   └── {id}.json         ← { mime, fileName, folder, size, savedAt }
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// [A] تهيئة OPFS
// ═══════════════════════════════════════════════════════════════

const OPFS_FILES_DIR = 'niaba_files';
const OPFS_META_DIR  = 'niaba_meta';
let   _root          = null;   // FileSystemDirectoryHandle لـ OPFS
let   _filesDir      = null;
let   _metaDir       = null;
let   _ready         = false;
let   _initPromise   = null;

async function _initOPFS() {
    if (_ready) return true;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        try {
            _root     = await navigator.storage.getDirectory();
            _filesDir = await _root.getDirectoryHandle(OPFS_FILES_DIR, { create: true });
            _metaDir  = await _root.getDirectoryHandle(OPFS_META_DIR,  { create: true });
            _ready    = true;
            console.log('[OPFS-Worker] تهيئة OPFS ناجحة ✅');
            return true;
        } catch (e) {
            console.error('[OPFS-Worker] فشل تهيئة OPFS:', e);
            return false;
        }
    })();
    return _initPromise;
}

// ═══════════════════════════════════════════════════════════════
// [B] عمليات القراءة / الكتابة الأساسية
// ═══════════════════════════════════════════════════════════════

/**
 * كتابة ملف واحد في OPFS
 * يستخدم createSyncAccessHandle إن أمكن (أسرع)، وإلا createWritable
 */
async function _writeFile(id, buffer, mime, fileName, folder) {
    const fileKey  = _sanitizeKey(id) + '.bin';
    const metaKey  = _sanitizeKey(id) + '.json';

    // كتابة البيانات الثنائية
    try {
        const fh = await _filesDir.getFileHandle(fileKey, { create: true });
        try {
            // مسار الأداء الأمثل: OPFS Sync Access Handle (Chrome 102+)
            const sah = await fh.createSyncAccessHandle();
            sah.truncate(0);
            sah.write(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
            sah.flush();
            sah.close();
        } catch (_syncErr) {
            // Fallback: createWritable (متوافق مع كل المتصفحات)
            const writable = await fh.createWritable();
            await writable.write(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
            await writable.close();
        }
    } catch (e) {
        throw new Error('OPFS write error [' + id + ']: ' + e.message);
    }

    // كتابة الـ metadata
    try {
        const mh = await _metaDir.getFileHandle(metaKey, { create: true });
        const meta = JSON.stringify({
            mime:    mime || 'application/octet-stream',
            fileName:fileName || '',
            folder:  folder  || '',
            size:    buffer.byteLength || (buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.buffer.byteLength),
            savedAt: Date.now()
        });
        const metaBuf = new TextEncoder().encode(meta);
        try {
            const sah = await mh.createSyncAccessHandle();
            sah.truncate(0);
            sah.write(metaBuf);
            sah.flush();
            sah.close();
        } catch (_syncErr) {
            const writable = await mh.createWritable();
            await writable.write(metaBuf);
            await writable.close();
        }
    } catch (e) {
        // metadata failure is non-fatal
        console.warn('[OPFS-Worker] meta write warning:', e.message);
    }
}

async function _readFile(id) {
    const fileKey = _sanitizeKey(id) + '.bin';
    const metaKey = _sanitizeKey(id) + '.json';

    try {
        const fh   = await _filesDir.getFileHandle(fileKey);
        const file = await fh.getFile();
        const buf  = await file.arrayBuffer();

        let mime = 'application/octet-stream';
        try {
            const mh   = await _metaDir.getFileHandle(metaKey);
            const mf   = await mh.getFile();
            const meta = JSON.parse(await mf.text());
            mime = meta.mime || mime;
        } catch (_) { /* meta missing is ok */ }

        return { buffer: buf, mime };
    } catch (e) {
        return null;
    }
}

async function _deleteFile(id) {
    const fileKey = _sanitizeKey(id) + '.bin';
    const metaKey = _sanitizeKey(id) + '.json';
    let deleted = false;
    try { await _filesDir.removeEntry(fileKey); deleted = true; } catch(_) {}
    try { await _metaDir.removeEntry(metaKey); } catch(_) {}
    return deleted;
}

async function _existsFile(id) {
    const fileKey = _sanitizeKey(id) + '.bin';
    try {
        await _filesDir.getFileHandle(fileKey);
        return true;
    } catch(_) { return false; }
}

async function _listFiles() {
    const keys = [];
    try {
        for await (const [name] of _filesDir.entries()) {
            if (name.endsWith('.bin')) keys.push(name.replace('.bin', ''));
        }
    } catch (e) { /* ignore */ }
    return keys;
}

async function _getStats() {
    let fileCount = 0, totalBytes = 0;
    try {
        for await (const [name, handle] of _filesDir.entries()) {
            if (!name.endsWith('.bin')) continue;
            fileCount++;
            try {
                const f = await handle.getFile();
                totalBytes += f.size;
            } catch(_) {}
        }
    } catch(e) {}
    return { fileCount, totalBytes };
}

// ═══════════════════════════════════════════════════════════════
// [C] عمليات الدفعة (Batch)
// ═══════════════════════════════════════════════════════════════

async function _writeMany(items, postProgress) {
    const errors  = [];
    let   written = 0;
    const total   = items.length;

    for (let i = 0; i < total; i++) {
        const item = items[i];
        try {
            await _writeFile(item.id, item.buffer, item.mime, item.fileName, item.folder);
            written++;
        } catch (e) {
            errors.push({ id: item.id, error: e.message });
        }
        // تقدم كل 10 ملفات
        if ((i + 1) % 10 === 0 || i === total - 1) {
            postProgress({ op: 'progress', written: written, total: total });
        }
    }
    return { written, errors };
}

async function _deleteMany(ids) {
    let deleted = 0;
    for (const id of ids) {
        if (await _deleteFile(id)) deleted++;
    }
    return deleted;
}

// ═══════════════════════════════════════════════════════════════
// [D] ترقية السجلات القديمة من Base64 إلى OPFS
// ═══════════════════════════════════════════════════════════════

/**
 * يستقبل سجلات قديمة فيها fileBase64، يحوّلها إلى OPFS ويُعيد
 * قائمة بالـ ids التي نجح تخزينها لحذف Base64 من IndexedDB
 */
async function _migrate(records, postProgress) {
    let migrated = 0;
    const total  = records.length;
    const migratedIds = [];

    for (let i = 0; i < total; i++) {
        const r = records[i];
        if (!r.fileBase64 || !r.id) continue;
        try {
            const buf = _base64ToBuffer(r.fileBase64);
            if (!buf) continue;
            const mime = r.fileMime || (r.fileType === 'pdf'
                ? 'application/pdf'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            await _writeFile(r.id, buf, mime, r.fileName || '', r.folder || '');
            migratedIds.push(r.id);
            migrated++;
        } catch (e) {
            console.warn('[OPFS-Worker] migrate error [' + r.id + ']:', e.message);
        }
        if ((i + 1) % 10 === 0 || i === total - 1) {
            postProgress({ op: 'progress', written: migrated, total: total });
        }
    }
    return { migrated, migratedIds };
}

// ═══════════════════════════════════════════════════════════════
// [E] مساعدات
// ═══════════════════════════════════════════════════════════════

function _sanitizeKey(id) {
    // يحوّل الـ ID إلى اسم ملف آمن
    return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function _base64ToBuffer(b64) {
    try {
        const bin  = atob(b64);
        const buf  = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// [F] معالج الرسائل الرئيسي
// ═══════════════════════════════════════════════════════════════

self.onmessage = async function (event) {
    const msg = event.data;
    if (!msg || !msg.op) return;

    // ping: اختبار حياة الـ worker
    if (msg.op === 'ping') {
        self.postMessage({ op: 'ping', ok: true, ready: _ready });
        return;
    }

    // تأكد من تهيئة OPFS
    const opfsOk = await _initOPFS();
    if (!opfsOk) {
        self.postMessage({ op: msg.op, id: msg.id, ok: false, error: 'OPFS غير مدعوم في هذا المتصفح' });
        return;
    }

    try {
        switch (msg.op) {

            // ── كتابة ملف واحد ──────────────────────────────────
            case 'write': {
                await _writeFile(msg.id, msg.buffer, msg.mime, msg.fileName, msg.folder);
                self.postMessage({ op: 'write', id: msg.id, ok: true });
                break;
            }

            // ── قراءة ملف واحد ──────────────────────────────────
            case 'read': {
                const result = await _readFile(msg.id);
                if (!result) {
                    self.postMessage({ op: 'read', id: msg.id, ok: false, error: 'الملف غير موجود في OPFS' });
                } else {
                    self.postMessage(
                        { op: 'read', id: msg.id, ok: true, buffer: result.buffer, mime: result.mime },
                        [result.buffer]  // ← transferable لتجنب النسخ
                    );
                }
                break;
            }

            // ── حذف ملف واحد ────────────────────────────────────
            case 'delete': {
                const deleted = await _deleteFile(msg.id);
                self.postMessage({ op: 'delete', id: msg.id, ok: true, deleted });
                break;
            }

            // ── تحقق من وجود ملف ────────────────────────────────
            case 'exists': {
                const exists = await _existsFile(msg.id);
                self.postMessage({ op: 'exists', id: msg.id, ok: true, exists });
                break;
            }

            // ── قائمة الملفات ────────────────────────────────────
            case 'list': {
                const keys = await _listFiles();
                self.postMessage({ op: 'list', ok: true, keys });
                break;
            }

            // ── كتابة دفعة ──────────────────────────────────────
            case 'writeMany': {
                const { written, errors } = await _writeMany(msg.items, p => self.postMessage(p));
                self.postMessage({ op: 'writeMany', ok: true, written, errors });
                break;
            }

            // ── حذف دفعة ────────────────────────────────────────
            case 'deleteMany': {
                const deleted = await _deleteMany(msg.ids);
                self.postMessage({ op: 'deleteMany', ok: true, deleted });
                break;
            }

            // ── ترقية سجلات Base64 → OPFS ───────────────────────
            case 'migrate': {
                const { migrated, migratedIds } = await _migrate(msg.records, p => self.postMessage(p));
                self.postMessage({ op: 'migrate', ok: true, migrated, migratedIds });
                break;
            }

            // ── إحصاءات ─────────────────────────────────────────
            case 'stats': {
                const stats = await _getStats();
                self.postMessage({ op: 'stats', ok: true, ...stats });
                break;
            }

            default:
                self.postMessage({ op: msg.op, ok: false, error: 'عملية غير معروفة: ' + msg.op });
        }
    } catch (e) {
        self.postMessage({ op: msg.op, id: msg.id, ok: false, error: e.message });
    }
};

// تهيئة تلقائية فور تحميل الـ worker
_initOPFS().catch(e => console.error('[OPFS-Worker] init error:', e));

console.log('[OPFS-Worker] ✅ تم تحميل opfs-worker.js — Origin Private File System جاهز');
