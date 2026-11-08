const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow () {
  // إنشاء نافذة نظام مخصصة بكامل الصلاحيات
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  title: "موسوعة نيابة النقض الجنائي – النسخة المكتبية المستقلة",
  autoHideMenuBar: false,
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false,
    webSecurity: false // تخطي قيود المتصفح الصارمة على الملفات وقواعد البيانات المحلية
  }
});

  // تحميل ملف الموسوعة الأساسي
  win.loadFile('index.html');

  // تعظيم النافذة عند التشغيل
  win.maximize();
}

// ─── IPC: قراءة ملفات من مجلد files/ عبر Node.js (حل مشكلة fetch+file://) ───
ipcMain.handle('read-local-file', async (event, relativePath) => {
  try {
    // relativePath مثل: "files/مجلد/ملف.docx"
    // نحوّله إلى مسار مطلق بجانب index.html
    const appDir = path.dirname(app.getAppPath());
    // في وضع التطوير: المجلد الحالي. في وضع الإنتاج: مجلد التطبيق
    const basePath = app.isPackaged
      ? path.dirname(process.execPath)
      : process.cwd();

    // تطبيع المسار النسبي (إزالة ../ للأمان)
    const safePath = path.normalize(path.join(basePath, relativePath));

    // حماية: لا نسمح بالخروج من مجلد التطبيق
    if (!safePath.startsWith(basePath)) {
      throw new Error('مسار غير مسموح به: ' + relativePath);
    }

    if (!fs.existsSync(safePath)) {
      throw new Error('الملف غير موجود: ' + safePath);
    }

    const buffer = fs.readFileSync(safePath);
    // نُعيد Buffer كـ Uint8Array لأن IPC لا ينقل Buffer مباشرة
    return { ok: true, data: Array.from(buffer) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
