/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Professional Database Engine (SQLite + LZ-Compression)                ║
 * ║   turns the project into a professional, portable, single-file system   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

class ProfessionalDB {
    constructor() {
        this.db = null;
        this.sql = null;
        this.initialized = false;
        this.dbFileName = 'encyclopedia.db';
    }

    /**
     * تهيئة قاعدة البيانات وتحميل ملف .db
     */
    async init() {
        if (this.initialized) return true;

        try {
            // تحميل sql.js WASM
            const SQL = await initSqlJs({
                locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
            });
            this.sql = SQL;

            // محاولة تحميل ملف .db من المجلد الحالي
            const dbData = await this._loadDbFile();
            if (dbData) {
                this.db = new SQL.Database(dbData);
                console.log('[ProfDB] Loaded existing database file.');
            } else {
                // إنشاء قاعدة بيانات جديدة
                this.db = new SQL.Database();
                await this._createSchema();
                console.log('[ProfDB] Created new database.');
            }

            this.initialized = true;
            return true;
        } catch (e) {
            console.error('[ProfDB] Init error:', e);
            return false;
        }
    }

    async _loadDbFile() {
        try {
            const response = await fetch(this.dbFileName);
            if (!response.ok) return null;
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            return null;
        }
    }

    async _createSchema() {
        // جدول البيانات الأساسي
        this.db.run(`
            CREATE TABLE IF NOT EXISTS appeals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fileName TEXT,
                folder TEXT,
                docType TEXT,
                fileType TEXT,
                crimeType TEXT,
                uploadDate INTEGER,
                appealNumber TEXT,
                isIndexed INTEGER,
                content_compressed TEXT,
                notes TEXT,
                fileBase64 TEXT,
                fileMime TEXT
            )
        `);

        // جدول البحث FTS5 (Fast Full Text Search)
        // SQLite FTS5 allows for extremely fast searching over millions of rows
        this.db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS appeals_fts USING fts5(
                fileName, folder, docType, content,
                content='appeals',
                content_rowid='id'
            )
        `);

        // Trigger لتحديث فهرس FTS عند الإضافة أو التعديل
        this.db.run(`
            CREATE TRIGGER IF NOT EXISTS appeals_ai AFTER INSERT ON appeals BEGIN
                INSERT INTO appeals_fts(rowid, fileName, folder, docType, content)
                VALUES (new.id, new.fileName, new.folder, new.docType, 
                        LZString.decompressFromUTF16(new.content_compressed));
            END;
        `);
        
        // ملاحظة: triggers in sql.js cannot call JS functions like LZString.
        // We must handle the FTS indexing manually in JS.
    }

    /**
     * ضغط النصوص لتقليل الحجم (LZ-String)
     */
    compress(text) {
        return LZString.compressToUTF16(text || '');
    }

    decompress(compressed) {
        return LZString.decompressFromUTF16(compressed || '');
    }

    /**
     * إضافة سجل جديد مع الفهرسة
     */
    async insertRecord(record) {
        if (!this.initialized) await this.init();

        const compressedContent = this.compress(record.content);
        
        this.db.run(`
            INSERT INTO appeals (fileName, folder, docType, fileType, crimeType, uploadDate, appealNumber, isIndexed, content_compressed, notes, fileBase64, fileMime)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                record.fileName, record.folder, record.docType, record.fileType, record.crimeType,
                record.uploadDate, record.appealNumber, record.isIndexed, compressedContent,
                record.notes, record.fileBase64, record.fileMime
            ]
        );

        const lastId = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
        
        // تحديث فهرس FTS يدوياً لأن SQLite WASM لا يدعم استدعاء JS داخل Triggers
        this.db.run(`INSERT INTO appeals_fts(rowid, fileName, folder, docType, content) VALUES (?, ?, ?, ?, ?)`,
            [lastId, record.fileName, record.folder, record.docType, record.content]
        );

        return lastId;
    }

    /**
     * البحث المتقدم باستخدام FTS5
     */
    async search(query, filters = {}) {
        if (!this.initialized) await this.init();

        // تحويل استعلام البحث لصيغة FTS5 (مثال: "كلمة1 AND كلمة2")
        // query هنا يجب أن يكون بتنسيق FTS5
        let sqlQuery = `
            SELECT rowid, score 
            FROM appeals_fts 
            WHERE appeals_fts MATCH ? 
            ORDER BY rank`;

        const params = [query];

        // إضافة الفلاتر إلى الاستعلام
        if (filters.docType && filters.docType !== 'all') {
            sqlQuery += ` AND docType = ?`;
            params.push(filters.docType);
        }
        if (filters.fileType && filters.fileType !== 'all') {
            sqlQuery += ` AND fileType = ?`;
            params.push(filters.fileType);
        }
        if (filters.crimeType && filters.crimeType !== 'all') {
            sqlQuery += ` AND crimeType = ?`;
            params.push(filters.crimeType);
        }

        const results = this.db.exec(sqlQuery, params);
        if (!results.length) return [];

        const ids = results[0].values.map(v => v[0]);
        const records = await this.getRecordsByIds(ids);
        return records;
    }

    async getRecordsByIds(ids) {
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(',');
        const res = this.db.exec(`SELECT * FROM appeals WHERE id IN (${placeholders})`, ids);
        if (!res.length) return [];

        const cols = res[0].columns;
        return res[0].values.map(row => {
            const rec = {};
            cols.forEach((col, i) => {
                if (col === 'content_compressed') {
                    rec.content = this.decompress(row[i]);
                } else {
                    rec[col] = row[i];
                }
            });
            return rec;
        });
    }

    async getRecord(id) {
        const res = this.db.exec(`SELECT * FROM appeals WHERE id = ?`, [id]);
        if (!res.length) return null;
        const cols = res[0].columns;
        const row = res[0].values[0];
        const rec = {};
        cols.forEach((col, i) => {
            if (col === 'content_compressed') {
                rec.content = this.decompress(row[i]);
            } else {
                rec[col] = row[i];
            }
        });
        return rec;
    }

    /**
     * تصدير قاعدة البيانات إلى ملف .db للتحميل
     */
    async exportDbFile() {
        const data = this.db.export();
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        return blob;
    }

    /**
     * تحويل البيانات من db-data.js (أو IndexedDB) إلى SQLite
     */
    async migrateFromLegacy(records) {
        console.log(`[ProfDB] Migrating ${records.length} records to SQLite...`);
        this.db.run("BEGIN TRANSACTION");
        try {
            for (const r of records) {
                const compressed = this.compress(r.content);
                this.db.run(`
                    INSERT INTO appeals (fileName, folder, docType, fileType, crimeType, uploadDate, appealNumber, isIndexed, content_compressed, notes, fileBase64, fileMime)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        r.fileName, r.folder, r.docType, r.fileType, r.crimeType,
                        r.uploadDate, r.appealNumber, r.isIndexed, compressed,
                        r.notes, r.fileBase64, r.fileMime
                    ]
                );
                const lastId = this.db.exec("SELECT last_insert_rowid()")[0].values[0][0];
                this.db.run(`INSERT INTO appeals_fts(rowid, fileName, folder, docType, content) VALUES (?, ?, ?, ?, ?)`,
                    [lastId, r.fileName, r.folder, r.docType, r.content]
                );
            }
            this.db.run("COMMIT");
            console.log('[ProfDB] Migration complete.');
        } catch (e) {
            this.db.run("ROLLBACK");
            console.error('[ProfDB] Migration failed:', e);
            throw e;
        }
    }
}

// Initialize a global instance
window.ProfessionalDB = new ProfessionalDB();
