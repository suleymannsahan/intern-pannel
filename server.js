const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// ===== AI İŞ PLANI AYARLARI =====
const KATEGORI_AY = { 1: 3, 2: 4, 3: 5, 4: 6 };

const IS_ADIMLARI = [
  { ad: 'Şematik İnceleme', yuzde: 10 },
  { ad: 'KTTD',            yuzde: 20 },
  { ad: 'BDK',             yuzde: 15 },
  { ad: 'Visio',           yuzde: 25 },
  { ad: 'Sequence',        yuzde: 20 },
  { ad: 'Entegrasyon',     yuzde: 10 }
];

function tarihFormatla(tarih) {
  const g = String(tarih.getDate()).padStart(2, '0');
  const a = String(tarih.getMonth() + 1).padStart(2, '0');
  const y = tarih.getFullYear();
  return `${g}.${a}.${y}`;
}

// Kategori + döküman + bitiş tarihine göre 6 adımı böler (opsiyonel akıllı ağırlıklarla)
function isPlaniHesapla(kategori, dokumanTarihiStr, bitisTarihiStr, agirliklar) {
  const baslangic = new Date(dokumanTarihiStr);
  const bitis = new Date(bitisTarihiStr);

  const toplamGun = Math.max(1, Math.round((bitis - baslangic) / (1000 * 60 * 60 * 24)));

  const kullanilacak = (agirliklar && agirliklar.length === IS_ADIMLARI.length)
    ? agirliklar
    : IS_ADIMLARI.map(a => ({ ad: a.ad, yuzde: a.yuzde }));

  let imlecTarih = new Date(baslangic);
  const adimlar = [];

  kullanilacak.forEach((adim) => {
    const adimGun = Math.round(toplamGun * adim.yuzde / 100);
    const adimBaslangic = new Date(imlecTarih);
    const adimBitis = new Date(imlecTarih);
    adimBitis.setDate(adimBitis.getDate() + adimGun);

    adimlar.push({
      ad: adim.ad,
      baslangic: tarihFormatla(adimBaslangic),
      bitis: tarihFormatla(adimBitis),
      gun: adimGun,
      kaynak: adim.kaynak || 'varsayilan',
      gecmisAdet: adim.gecmisAdet || 0
    });

    imlecTarih = new Date(adimBitis);
  });

  return {
    baslangic: tarihFormatla(baslangic),
    bitis: tarihFormatla(bitis),
    toplamGun,
    adimlar
  };
}

// Geçmiş gerçek verilere göre akıllı ağırlık (5+ kayıt varsa gerçek ortalama)
async function akilliAgirliklarHesapla(kategori) {
  const ESIK = 5;
  const ortalamalar = {};
  for (const adim of IS_ADIMLARI) {
    const r = await db.execute({
      sql: `SELECT AVG(gercek_gun) as ort, COUNT(*) as adet
            FROM asama_gecmisi WHERE asama_adi = ? AND kategori = ?`,
      args: [adim.ad, kategori]
    });
    const row = r.rows[0];
    ortalamalar[adim.ad] = { ortalama: row.ort ? Number(row.ort) : null, adet: Number(row.adet) };
  }

  const efektif = IS_ADIMLARI.map(adim => {
    const g = ortalamalar[adim.ad];
    if (g.ortalama !== null && g.adet >= ESIK) {
      return { ad: adim.ad, puan: g.ortalama, kaynak: 'gercek', adet: g.adet };
    }
    return { ad: adim.ad, puan: adim.yuzde, kaynak: 'varsayilan', adet: g.adet };
  });

  const toplamPuan = efektif.reduce((t, e) => t + e.puan, 0);
  return efektif.map(e => ({
    ad: e.ad,
    yuzde: (e.puan / toplamPuan) * 100,
    kaynak: e.kaynak,
    gecmisAdet: e.adet,
    gecmisOrtalama: ortalamalar[e.ad].ortalama
  }));
}
// ===== AI AYARLARI SONU =====

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Turso Bulut Veritabanı Bağlantısı
const db = createClient({
  url: 'file:local.db'
});

// Veritabanı sütunlarını tek tek kontrol edip yoksa ekleyen güvenli fonksiyon
async function initDbMigration() {
  const columnsToAdd = [
    { name: 'username', type: 'TEXT' },
    { name: 'department', type: 'TEXT' },
    { name: 'leader_sub_type', type: 'TEXT' },
    { name: 'status', type: "TEXT DEFAULT 'PENDING'" }
  ];

  for (const col of columnsToAdd) {
    try {
      // Her sütunu bağımsız try-catch bloğunda ekliyoruz.
      // Sütun zaten varsa hata verecek ve sessizce sonraki sütuna geçecek.
      await db.execute(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type};`);
      console.log(`✅ ${col.name} sütunu users tablosuna başarıyla eklendi.`);
    } catch (err) {
      // "duplicate column name" hatasını yutuyoruz, bu normaldir (sütun zaten var demektir).
      console.log(`ℹ️ ${col.name} sütun kontrolü: ${err.message}`);
    }
  }
}

// Sunucu kalkarken veya DB başlatılırken çağırın
initDbMigration();

// Veritabanı Tablolarını Oluşturma
async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        intern_start_date TEXT,
        intern_end_date TEXT
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to INTEGER NOT NULL,
        category TEXT NOT NULL,
        end_date TEXT NOT NULL,
        work_days INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT DEFAULT 'IN_PROGRESS',
        review_comment TEXT,
        FOREIGN KEY(assigned_to) REFERENCES users(id)
      )
    `);

    try { await db.execute(`ALTER TABLE tasks ADD COLUMN description TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN review_comment TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN start_date TEXT`); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS daily_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        intern_id INTEGER NOT NULL,
        log_date TEXT NOT NULL,
        note TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id),
        FOREIGN KEY(intern_id) REFERENCES users(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS task_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        revised_by TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS meeting_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_by INTEGER NOT NULL,
        department TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        preferred_date TEXT,
        status TEXT DEFAULT 'PENDING',
        reviewed_by TEXT,
        review_comment TEXT,
        created_at TEXT NOT NULL,
        target_roles TEXT,
        FOREIGN KEY(requested_by) REFERENCES users(id)
      )
    `);

    // target_roles: toplantının bildirileceği/hedef rol listesi (virgülle ayrık). Eski kayıtlar için güvenli ekleme.
    try { await db.execute(`ALTER TABLE meeting_requests ADD COLUMN target_roles TEXT`); } catch (e) {}

    // ===== AI İŞ PLANI: sütun + tarihsel tablo =====
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN is_plani TEXT`); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS asama_gecmisi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        asama_adi TEXT NOT NULL,
        kategori INTEGER,
        tahmini_gun INTEGER,
        gercek_gun INTEGER,
        baslangic TEXT,
        bitis TEXT,
        kaydeden TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_id INTEGER,
        tip TEXT,
        mesaj TEXT NOT NULL,
        okundu INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    // ===== AI İŞ PLANI SONU =====

    console.log('Turso bulut veritabanı tabloları hazır.');
  } catch (err) {
    console.error('Veritabanı başlatma hatası:', err.message);
  }
}

initDb();

// --- API ENDPOINT'LERİ ---

// Kayıt Ol Endpoint'i (Onay Mekanizmalı)
app.post('/api/register', async (req, res) => {
  try {
    const { 
      name, 
      username, 
      password, 
      role, 
      department, 
      leaderType, 
      startDate, 
      endDate 
    } = req.body;

    if (!name || !username || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun!' });
    }

    if (role === 'INTERN' && (!startDate || !endDate)) {
      return res.status(400).json({ error: 'Stajyerler için başlangıç ve bitiş tarihleri zorunludur!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const dummyEmail = `${username}@system.local`;

    // 💡 ONAY MANTIĞI: Ekip Lideri, Müdür veya İnsan Kaynakları departmanı onay beklemeye alınır (PENDING), diğerleri direkt onaylanır (APPROVED)
    const requiresApproval = ['MANAGER', 'LEADER'].includes(role) || department === 'INSAN_KAYNAKLARI';
    const initialStatus = requiresApproval ? 'PENDING' : 'APPROVED';

    const result = await db.execute({
      sql: `INSERT INTO users (
              name, 
              username, 
              email, 
              password, 
              role, 
              department, 
              leader_sub_type, 
              intern_start_date, 
              intern_end_date,
              status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        name, 
        username, 
        dummyEmail,
        hashedPassword, 
        role, 
        department || null,
        leaderType || null,
        role === 'INTERN' ? startDate : null, 
        role === 'INTERN' ? endDate : null,
        initialStatus
      ]
    });

    const successMessage = initialStatus === 'PENDING'
      ? 'Kayıt başarılı! Hesabınız yönetici onayından sonra aktif olacaktır.'
      : 'Kullanıcı başarıyla oluşturuldu.';

    res.json({ 
      message: successMessage, 
      userId: Number(result.lastInsertRowid),
      status: initialStatus
    });

  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış!' });
    }
    console.error("Kayıt hatası:", error);
    res.status(500).json({ error: 'Veritabanı hatası: ' + error.message });
  }
});

// Giriş Yap Endpoint'i (Status Kontrollü)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const user = result.rows[0];

    // Şifre Kontrolü
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    // ONAY KONTROLÜ (status === 'PENDING' durumu)
    if (user.status === 'PENDING') {
      return res.status(403).json({ 
        error: 'Hesabınız henüz Admin tarafından onaylanmamıştır. Lütfen onay bekleyiniz.' 
      });
    }

    // Başarılı Giriş
    res.json({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      department: user.department,
      leaderType: user.leader_sub_type,
      status: user.status
    });
  } catch (err) {
    console.error('Giriş Hatası:', err);
    res.status(500).json({ error: 'Sunucu hatası oluştu.' });
  }
});

// GET /api/users/pending - Onay Bekleyen Yönetici / Liderleri Getir
app.get('/api/users/pending', async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT id, name, username, department, role, leader_sub_type AS leaderType, status 
       FROM users 
       WHERE status = 'PENDING' 
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Pending kullanıcı getirme hatası:', err);
    res.status(500).json({ error: 'Veriler alınırken bir sorun oluştu.' });
  }
});

// PATCH /api/users/:id/approve - Kullanıcıyı Onayla
app.patch('/api/users/:id/approve', async (req, res) => {
  try {
    const userId = req.params.id;

    const result = await db.execute({
      sql: `UPDATE users SET status = 'APPROVED' WHERE id = ?`,
      args: [userId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const updated = await db.execute({
      sql: `SELECT id, name, status FROM users WHERE id = ?`,
      args: [userId]
    });

    res.json({
      message: 'Kullanıcı başarıyla onaylandı.',
      user: updated.rows[0]
    });
  } catch (err) {
    console.error('Kullanıcı onaylama hatası:', err);
    res.status(500).json({ error: 'Onaylama işlemi başarısız.' });
  }
});

// Şifre Sıfırlama
app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const result = await db.execute({
      sql: `UPDATE users SET password = ? WHERE email = ?`,
      args: [hashedPassword, email]
    });

    if (result.rowsAffected === 0) return res.status(400).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Şifre güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});


// Kullanıcı Kendi Profil Bilgilerini Güncelleme (Tüm Kayıt Alanları Dahil)
app.put('/api/users/profile', async (req, res) => {
  try {
    const { userId, name, email, password, startDate, endDate, engineerId } = req.body;

    if (!userId || !name || !email) {
      return res.status(400).json({ error: 'Zorunlu alanlar eksik!' });
    }

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, password = ?, intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
        args: [name, email, hashedPassword, startDate || null, endDate || null, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
        args: [name, email, startDate || null, endDate || null, userId]
      });
    }

    res.json({ message: 'Profil başarıyla güncellendi.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Profil güncellenirken hata oluştu: ' + error.message });
  }
});

// Kullanıcı Listesi
app.get('/api/users', async (req, res) => {
  try {
    const { department, role } = req.query;

    let sql = `SELECT id, name, email, username, department, role, status, intern_start_date, intern_end_date FROM users`;
    let args = [];

    // Departman bazlı görünürlük: ADMIN ve HR hariç herkes sadece kendi biriminin personelini görür
    if (role && role !== 'ADMIN' && role !== 'HR' && department) {
      sql += ` WHERE department = ?`;
      args.push(department);
    }

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Staj Tarihlerini Güncelleme
app.put('/api/users/:id/intern-dates', async (req, res) => {
  try {
    const userId = req.params.id;
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Başlangıç ve bitiş tarihleri gereklidir.' });
    }

    await db.execute({
      sql: `UPDATE users SET intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
      args: [startDate, endDate, userId]
    });

    res.json({ message: 'Staj tarihleri başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Tarihler kaydedilemedi: ' + error.message });
  }
});

// Görev Oluşturma
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assignedTo, category, startDate, endDate, workDays, createdBy, userRole } = req.body;

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Görev atamaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, category, start_date, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, description || '', assignedTo, category, startDate || null, endDate, workDays, createdBy]
    });

    const userResult = await db.execute({
      sql: `SELECT name, email FROM users WHERE id = ?`,
      args: [assignedTo]
    });

    const intern = userResult.rows[0];

    if (intern && intern.email) {
      try {
        const companyLogoUrl = "https://i.ibb.co/xtFPW7KP/Y-logo.png"; 
        const appDashboardUrl = "https://intern-tasks-pannel.onrender.com/"; 

        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: "Görev & Takip Sistemi", email: "semresahann@gmail.com" },
            to: [{ email: intern.email, name: intern.name }],
            subject: `Yeni Görev Atandı: ${title}`,
            htmlContent: `
              <div style="background-color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #0f172a;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);">
                  
                  <!-- Header & Logo -->
                  <div style="text-align: center; margin-bottom: 28px;">
                    <img src="${companyLogoUrl}" alt="Logo" style="height: 48px; width: auto; margin-bottom: 12px;" />
                    <h2 style="color: #0284c7; margin: 0; font-size: 20px; font-weight: 700;">Yeni Görev Bildirimi</h2>
                  </div>

                  <!-- Main Content -->
                  <p style="font-size: 15px; line-height: 1.6; color: #ffffff; margin-bottom: 20px;">
                    Merhaba <strong style="color: #38bdf8;">${intern.name}</strong>,
                  </p>
                  <p style="font-size: 15px; line-height: 1.6; color: #ffffff; margin-bottom: 24px;">
                    <strong style="color: #0284c7;">${createdBy}</strong> tarafından tarafınıza yeni bir görev atandı. Detaylar aşağıda yer almaktadır:
                  </p>

                  <!-- Details Card (Koyu Bilgi Alanı) -->
                  <div style="background-color: #1e293b; border-radius: 12px; border: 1px solid #334155; padding: 20px; margin-bottom: 28px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                      <tr>
                        <td style="padding: 6px 0; color: #94a3b8; width: 120px;">Görev Başlığı:</td>
                        <td style="padding: 6px 0; color: #ffffff; font-weight: 600;">${title}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #94a3b8;">Kategori:</td>
                        <td style="padding: 6px 0; color: #ffffff;">${category}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #94a3b8;">Son Teslim:</td>
                        <td style="padding: 6px 0; color: #38bdf8; font-weight: 600;">${endDate} (${workDays} İş Günü)</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #94a3b8;">Atayan Lider:</td>
                        <td style="padding: 6px 0; color: #ffffff;">${createdBy}</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #94a3b8;">Açıklama:</td>
                        <td style="padding: 6px 0; color: #cbd5e1;">${description || 'Açıklama bulunmuyor.'}</td>
                      </tr>
                    </table>
                  </div>

                  <!-- Action Button -->
                  <div style="text-align: center; margin-bottom: 12px;">
                    <a href="${appDashboardUrl}" style="background: linear-gradient(135deg, #0284c7 0%, #06b6d4 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 28px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.25);">
                      Görevi İncele
                    </a>
                  </div>

                </div>
                
                <!-- Footer -->
                <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #64748b;">
                  <p style="margin: 0;">Bu e-posta Görev & Takip Sistemi tarafından otomatik olarak gönderilmiştir.</p>
                </div>
              </div>
            `
          })
        });
      } catch (mailErr) {
        console.error('Görev maili gönderilirken hata oluştu:', mailErr);
      }
    }

    res.json({ id: Number(result.lastInsertRowid), message: "Görev oluşturuldu ve e-posta bildirimi gönderildi." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Yetki Kontrolü Fonksiyonu
const isAdmin = (role) => role === 'ADMIN';

// Görev Getirme Endpoint'ini Admin İçin Güncelleme
app.get('/api/tasks', async (req, res) => {
  try {
    const { userId, role, department } = req.query;

    let sql = `
      SELECT tasks.*, users.name as assignee_name 
      FROM tasks 
      LEFT JOIN users ON tasks.assigned_to = users.id
    `;
    let conditions = [];
    let args = [];

    // ADMIN tüm görevleri görebilir; INTERN sadece kendisine atananları görür;
    // diğer roller (Müdür, Ekip Lideri, Mühendis, Teknisyen) sadece kendi biriminin görevlerini görür.
    if (role === 'INTERN') {
      conditions.push(`tasks.assigned_to = ?`);
      args.push(userId);
    } else if (role !== 'ADMIN' && department) {
      conditions.push(`users.department = ?`);
      args.push(department);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY tasks.id DESC`;

    const result = await db.execute({ sql, args });
    const tasks = result.rows.map(row => ({ ...row, revisions: [] }));

    if (tasks.length === 0) return res.json([]);

    const taskIds = tasks.map(t => t.id);
    const placeholders = taskIds.map(() => '?').join(',');

    const revisionsResult = await db.execute({
      sql: `SELECT * FROM task_revisions WHERE task_id IN (${placeholders}) ORDER BY id DESC`,
      args: taskIds
    });

    const revisionsByTaskId = {};
    for (const rev of revisionsResult.rows) {
      if (!revisionsByTaskId[rev.task_id]) revisionsByTaskId[rev.task_id] = [];
      revisionsByTaskId[rev.task_id].push(rev);
    }

    const finalTasks = tasks.map(task => ({
      ...task,
      revisions: revisionsByTaskId[task.id] || []
    }));

    res.json(finalTasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ADMIN ÖZEL ENDPOINT'LERİ ---

// 1. Tüm Kullanıcıları Listele (Admin Paneli İçin)
app.get('/api/admin/users', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: 'Bu alana erişim yetkiniz yok.' });
    }

    const result = await db.execute(`SELECT id, name, username, email, department, role, status FROM users ORDER BY id DESC`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Yeni Kullanıcı Oluştur (Admin Paneli)
app.post('/api/admin/users', async (req, res) => {
  try {
    const { name, username, email, password, role, department, adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    if (!name || !username || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const finalEmail = email && email.trim() !== '' ? email : `${username}@system.local`;

    await db.execute({
      sql: `INSERT INTO users (name, username, email, password, role, department, status) VALUES (?, ?, ?, ?, ?, ?, 'APPROVED')`,
      args: [name, username, finalEmail, hashedPassword, role, department || null]
    });

    res.json({ message: 'Kullanıcı başarıyla oluşturuldu.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu kullanıcı adı veya e-posta zaten kullanılıyor!' });
    }
    res.status(500).json({ error: 'Kullanıcı eklenirken hata: ' + error.message });
  }
});

// 3. Kullanıcı Rolünü Güncelle
app.put('/api/admin/users/:id/role', async (req, res) => {
  try {
    const userId = req.params.id;
    const { newRole, department, adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    if (department !== undefined) {
      await db.execute({
        sql: `UPDATE users SET role = ?, department = ? WHERE id = ?`,
        args: [newRole, department || null, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET role = ? WHERE id = ?`,
        args: [newRole, userId]
      });
    }

    res.json({ message: 'Kullanıcı bilgileri güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Kullanıcı Sil
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    // Kullanıcıya ait görevlerin ID'lerini bul (revizyon kayıtlarını temizlemek için gerekli)
    const tasksResult = await db.execute({
      sql: `SELECT id FROM tasks WHERE assigned_to = ?`,
      args: [userId]
    });
    const taskIds = tasksResult.rows.map(r => r.id);

    // İlişkili tüm kayıtları sırasıyla temizle (foreign key hatası almamak için)
    for (const taskId of taskIds) {
      await db.execute({ sql: `DELETE FROM task_revisions WHERE task_id = ?`, args: [taskId] });
    }
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM meeting_requests WHERE requested_by = ?`, args: [userId] });

    const result = await db.execute({
      sql: `DELETE FROM users WHERE id = ?`,
      args: [userId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Silinecek kullanıcı bulunamadı.' });
    }

    res.json({ message: 'Kullanıcı ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Kullanıcı silinirken hata oluştu: ' + error.message });
  }
});

// 5. Sistem Genel İstatistikleri
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { userRole } = req.query;
    if (!isAdmin(userRole)) {
      return res.status(403).json({ error: 'Yetkisiz erişim.' });
    }

    const userCount = await db.execute(`SELECT COUNT(*) as count FROM users`);
    const taskCount = await db.execute(`SELECT COUNT(*) as count FROM tasks`);
    const revisionCount = await db.execute(`SELECT COUNT(*) as count FROM task_revisions`);
    const pendingTasks = await db.execute(`SELECT COUNT(*) as count FROM tasks WHERE status = 'COMPLETED'`);

    res.json({
      totalUsers: userCount.rows[0].count,
      totalTasks: taskCount.rows[0].count,
      totalRevisions: revisionCount.rows[0].count,
      pendingApprovalTasks: pendingTasks.rows[0].count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Geliştirme 1: Görevi Tamamlama & Brevo ile Ekip Liderine Mail Bildirimi
app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await db.execute({
      sql: `UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`,
      args: [taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    // Görev ve stajyer detaylarını çek
    const taskRes = await db.execute({
      sql: `SELECT tasks.*, users.name as intern_name FROM tasks JOIN users ON tasks.assigned_to = users.id WHERE tasks.id = ?`,
      args: [taskId]
    });
    const task = taskRes.rows[0];

    if (task) {
      // Görevi oluşturan lider/mühendisin mailini bul
      const creatorRes = await db.execute({
        sql: `SELECT email, name FROM users WHERE name = ?`,
        args: [task.created_by]
      });
      const creator = creatorRes.rows[0];

      if (creator && creator.email) {
        try {
          const companyLogoUrl = "https://i.ibb.co/xtFPW7KP/Y-logo.png";
          const appDashboardUrl = "https://intern-tasks-pannel.onrender.com/";

          await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'api-key': process.env.BREVO_API_KEY,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              sender: { name: "Görev & Takip Sistemi", email: "semresahann@gmail.com" },
              to: [{ email: creator.email, name: creator.name }],
              subject: `Görev Tamamlandı: ${task.title}`,
              htmlContent: `
                <div style="background-color: #ffffff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #0f172a;">
                  <div style="max-width: 600px; margin: 0 auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);">
                    
                    <!-- Header & Logo -->
                    <div style="text-align: center; margin-bottom: 28px;">
                      <img src="${companyLogoUrl}" alt="Logo" style="height: 48px; width: auto; margin-bottom: 12px;" />
                      <h2 style="color: #0284c7; margin: 0; font-size: 20px; font-weight: 700;">Görev Tamamlandı Bildirimi</h2>
                    </div>

                    <!-- Main Content -->
                    <p style="font-size: 15px; line-height: 1.6; color: #ffffff; margin-bottom: 20px;">
                      Merhaba <strong style="color: #38bdf8;">${creator.name}</strong>,
                    </p>
                    <p style="font-size: 15px; line-height: 1.6; color: #ffffff; margin-bottom: 24px;">
                      <strong style="color: #0284c7;">${task.intern_name}</strong> isimli stajyer kendisine atanan görevi tamamlandı olarak işaretledi. Detaylar aşağıda yer almaktadır:
                    </p>

                    <!-- Details Card (Koyu Bilgi Alanı) -->
                    <div style="background-color: #1e293b; border-radius: 12px; border: 1px solid #1e293b; padding: 20px; margin-bottom: 28px;">
                      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr>
                          <td style="padding: 6px 0; color: #94a3b8; width: 120px;">Görev Başlığı:</td>
                          <td style="padding: 6px 0; color: #ffffff; font-weight: 600;">${task.title}</td>
                        </tr>
                        <tr>
                          <td style="padding: 6px 0; color: #94a3b8;">Kategori:</td>
                          <td style="padding: 6px 0; color: #ffffff;">${task.category}</td>
                        </tr>
                        <tr>
                          <td style="padding: 6px 0; color: #94a3b8;">Tamamlayan:</td>
                          <td style="padding: 6px 0; color: #38bdf8; font-weight: 600;">${task.intern_name}</td>
                        </tr>
                        <tr>
                          <td style="padding: 6px 0; color: #94a3b8;">Açıklama:</td>
                          <td style="padding: 6px 0; color: #cbd5e1;">${task.description || 'Açıklama bulunmuyor.'}</td>
                        </tr>
                      </table>
                    </div>

                    <!-- Action Button -->
                    <div style="text-align: center; margin-bottom: 12px;">
                      <a href="${appDashboardUrl}" style="background: linear-gradient(135deg, #0284c7 0%, #06b6d4 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 28px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(6, 182, 212, 0.25);">
                        Görevi İncele ve Onayla
                      </a>
                    </div>

                  </div>
                  
                  <!-- Footer -->
                  <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #64748b;">
                    <p style="margin: 0;">Bu e-posta Görev & Takip Sistemi tarafından otomatik olarak gönderilmiştir.</p>
                  </div>
                </div>
              `
            })
          });
        } catch (mailErr) {
          console.error('Tamamlama maili hatası:', mailErr);
        }
      }
    }

    res.json({ message: 'Görev tamamlandı olarak işaretlendi ve bildirim e-postası gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + error.message });
  }
});

// Görev Onaylama / Revize Etme Endpoint'i
app.put('/api/tasks/:id/review', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { action, comment, userRole, revisedBy } = req.body;

    // Yetki Kontrolü
    const canReview = ['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole);
    if (!canReview) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz bulunmamaktadır.' });
    }

    let newStatus = 'APPROVED';
    const isRevision = (action === 'REVISION' || action === 'REVISION_REQUESTED');

    if (isRevision) {
      newStatus = 'REVISION_REQUESTED';

      // Zaman damgası (YYYY-MM-DD HH:mm:ss)
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

      // Revizyon geçmişi kaydı ekle
      await db.execute({
        sql: `INSERT INTO task_revisions (task_id, revised_by, comment, created_at) VALUES (?, ?, ?, ?)`,
        args: [taskId, revisedBy || 'Sistem / Yetkili', comment || '', now]
      });
    }

    // Görev durumunu ve son revize notunu veritabanında güncelle
    const result = await db.execute({
      sql: `UPDATE tasks SET status = ?, review_comment = ? WHERE id = ?`,
      args: [newStatus, isRevision ? (comment || '') : '', taskId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Görev bulunamadı.' });
    }

    res.json({ message: !isRevision ? 'Görev onaylandı.' : 'Revize talebi iletildi.' });
  } catch (error) {
    console.error('Görev inceleme hatası:', error);
    res.status(500).json({ error: 'Görev durumu güncellenirken hata oluştu: ' + error.message });
  }
});

// Günlük Not Ekleme
app.post('/api/daily-logs', async (req, res) => {
  try {
    const { taskId, internId, logDate, note } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`,
      args: [taskId, internId, logDate, note]
    });

    res.json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Notları Getirme
app.get('/api/daily-logs', async (req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM daily_logs`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Silme Endpoint'ii
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Göreve ait logları ve revizyonları temizle
    await db.execute({
      sql: `DELETE FROM daily_logs WHERE task_id = ?`,
      args: [taskId]
    });
    await db.execute({
      sql: `DELETE FROM task_revisions WHERE task_id = ?`,
      args: [taskId]
    });

    // Görevi sil
    const result = await db.execute({
      sql: `DELETE FROM tasks WHERE id = ?`,
      args: [taskId]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Görev bulunamadı.' });
    }

    res.json({ message: 'Görev başarıyla silindi.' });
  } catch (error) {
    console.error('Görev silme hatası:', error);
    res.status(500).json({ error: 'Görev silinirken bir hata oluştu: ' + error.message });
  }
});

// Stajyer Silme
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const tasksResult = await db.execute({
      sql: `SELECT id FROM tasks WHERE assigned_to = ?`,
      args: [userId]
    });
    const taskIds = tasksResult.rows.map(r => r.id);

    for (const taskId of taskIds) {
      await db.execute({ sql: `DELETE FROM task_revisions WHERE task_id = ?`, args: [taskId] });
    }
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM meeting_requests WHERE requested_by = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Silinecek kullanıcı bulunamadı.' });
    res.json({ message: 'Kullanıcı ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Kullanıcı silinirken hata oluştu: ' + error.message });
  }
});

// Görev Güncelleme Endpoint'i
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { title, description, assignedTo, category, startDate, endDate, workDays, userRole } = req.body;

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, category = ?, start_date = ?, end_date = ?, work_days = ? WHERE id = ?`,
      args: [title, description || '', assignedTo, category, startDate || null, endDate, workDays, taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    res.json({ message: 'Görev başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev güncellenemedi: ' + error.message });
  }
});

// Kullanıcının Kendi Hesabını Silmesi
app.delete('/api/users/profile', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Kullanıcı ID eksik!' });
    }

    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Hesap ve ilişkili veriler başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Hesap silinirken hata oluştu: ' + error.message });
  }
});

// Ekip Liderinin / Mühendisin Bir Kullanıcıyı Düzenlemesi
app.put('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, email, role, startDate, endDate } = req.body;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Ad, e-posta ve rol alanları zorunludur.' });
    }

    await db.execute({
      sql: `UPDATE users SET name = ?, email = ?, role = ?, intern_start_date = ?, intern_end_date = ? WHERE id = ?`,
      args: [
        name, 
        email, 
        role, 
        role === 'INTERN' ? startDate : null, 
        role === 'INTERN' ? endDate : null, 
        userId
      ]
    });

    res.json({ message: 'Kullanıcı bilgileri başarıyla güncellendi.' });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor!' });
    }
    res.status(500).json({ error: 'Kullanıcı güncellenirken hata oluştu: ' + error.message });
  }
});

// Doğrulama Kodu Gönderme Endpoint'i
app.post('/api/send-verification-code', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'E-posta adresi gereklidir.' });
  }

  try {
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: "Ekip Portali", email: "semresahann@gmail.com" },
        to: [{ email: email }],
        subject: "Ekip Lideri Doğrulama Kodu",
        htmlContent: `<p>Ekip Lideri kayıt doğrulama kodunuz: <strong>${verificationCode}</strong></p>`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Brevo API isteği başarısız oldu.');
    }

    return res.status(200).json({ message: 'Kod başarıyla gönderildi.', data });

  } catch (error) {
    console.error('Brevo Mail Gönderme Hatası:', error);
    return res.status(500).json({ error: 'Mail gönderilirken sunucu hatası oluştu: ' + error.message });
  }
});

// --- TOPLANTI TALEBİ ENDPOINT'LERİ ---

// Yeni Toplantı Talebi Oluşturma (Sadece Mühendis ve üstü roller: ENGINEER, LEADER, MANAGER)
app.post('/api/meetings', async (req, res) => {
  try {
    const { requestedBy, subject, description, preferredDate, userRole, targetDepartment, targetRoles } = req.body;

    if (!['ENGINEER', 'LEADER', 'MANAGER', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ error: 'Toplantı talebi oluşturmak için yetkiniz yok.' });
    }

    if (!requestedBy || !subject) {
      return res.status(400).json({ error: 'Talep eden kullanıcı ve konu alanı zorunludur.' });
    }

    // Her rolün toplantıya davet edebileceği (bildirim düşürebileceği) hedef roller
    const ALLOWED_TARGETS = {
      LEADER: ['ENGINEER'],                          // Ekip lideri -> mühendisler
      MANAGER: ['LEADER', 'ENGINEER'],               // Müdür -> ekip lideri ve mühendisler
      ADMIN: ['MANAGER', 'LEADER', 'ENGINEER'],      // Admin -> müdür, ekip lideri, mühendisler
      ENGINEER: ['INTERN']                           // Mühendis -> stajyerler
    };

    // Gelen hedef rolleri normalize et ve yetkiye göre filtrele
    let rolesArr = Array.isArray(targetRoles)
      ? targetRoles
      : (targetRoles ? String(targetRoles).split(',') : []);
    rolesArr = rolesArr.map(r => r.trim()).filter(Boolean);

    const allowedForRole = ALLOWED_TARGETS[userRole] || [];
    rolesArr = rolesArr.filter(r => allowedForRole.includes(r));

    let department;

    if (userRole === 'ADMIN') {
      // Admin istediği ekipten toplantı isteyebilir; birim seçimi zorunludur
      if (!targetDepartment) {
        return res.status(400).json({ error: 'Lütfen bir birim seçiniz.' });
      }
      department = targetDepartment;
    } else {
      // Diğer roller için talep edenin birimini güvenlik amacıyla veritabanından doğrula
      const userResult = await db.execute({
        sql: `SELECT department FROM users WHERE id = ?`,
        args: [requestedBy]
      });

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
      }

      department = userResult.rows[0].department;
    }

    const targetRolesStr = rolesArr.length > 0 ? rolesArr.join(',') : null;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const result = await db.execute({
      sql: `INSERT INTO meeting_requests (requested_by, department, subject, description, preferred_date, status, created_at, target_roles) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      args: [requestedBy, department || null, subject, description || null, preferredDate || null, now, targetRolesStr]
    });

    res.json({ id: Number(result.lastInsertRowid), message: 'Toplantı talebiniz iletildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Toplantı talebi oluşturulurken hata: ' + error.message });
  }
});

// Toplantı Taleplerini Listeleme
app.get('/api/meetings', async (req, res) => {
  try {
    const { userId, role, department } = req.query;

    let sql = `
      SELECT meeting_requests.*, users.name as requester_name, users.role as requester_role
      FROM meeting_requests
      LEFT JOIN users ON meeting_requests.requested_by = users.id
    `;
    let conditions = [];
    let args = [];

    if (['MANAGER', 'LEADER'].includes(role)) {
      // Müdür/Ekip Lideri: kendi biriminden gelen talepleri VEYA kendisine (rolüne) yönlendirilen talepleri görür
      conditions.push(`(meeting_requests.department = ? OR meeting_requests.requested_by = ? OR meeting_requests.target_roles LIKE ?)`);
      args.push(department, userId, `%${role}%`);
    } else if (role === 'ADMIN') {
      // Admin tüm talepleri görebilir, ek filtre yok
    } else {
      // Diğer roller (ör. Mühendis): kendi oluşturdukları talepleri VEYA kendilerine yönlendirilen (bildirim düşen) talepleri görür
      conditions.push(`(meeting_requests.requested_by = ? OR meeting_requests.target_roles LIKE ?)`);
      args.push(userId, `%${role}%`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY meeting_requests.id DESC`;

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- EKİP GİDİŞATI ---
// Rol hiyerarşisi (yüksekten alçağa): MANAGER > LEADER > ENGINEER > TECHNICIAN > INTERN
// Her rol yalnızca kendi altındaki rolleri görebilir. ADMIN herkesi görür.
const ROLE_HIERARCHY = ['MANAGER', 'LEADER', 'ENGINEER', 'TECHNICIAN', 'INTERN'];

// Verilen rolün görebileceği (kendisinden düşük) rollerin listesini döndürür
function getSubordinateRoles(role) {
  const idx = ROLE_HIERARCHY.indexOf(role);
  if (idx === -1) return [];
  return ROLE_HIERARCHY.slice(idx + 1);
}

// Seçilen birim(ler)/rol(ler) için kişi listesi + görev + günlük log verisi
app.get('/api/admin/team-progress', async (req, res) => {
  try {
    const { userRole, departments, roles, userId, viewerDepartment } = req.query;

    // ADMIN veya rol hiyerarşisinde yer alan (alt rolleri olan) roller erişebilir
    const canView = isAdmin(userRole) || getSubordinateRoles(userRole).length > 0;
    if (!canView) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Tek bir kişi için sorgu (kişi detay ekranı)
    if (userId) {
      const userResult = await db.execute({
        sql: `SELECT id, name, role, department FROM users WHERE id = ?`,
        args: [userId]
      });
      const people = userResult.rows;

      if (people.length === 0) {
        return res.json({ people: [], tasks: [], logs: [] });
      }

      // ADMIN değilse: hedef kişi kendi altındaki bir rolde ve kendi biriminde olmalı
      if (!isAdmin(userRole)) {
        const target = people[0];
        const allowedRoles = getSubordinateRoles(userRole);
        const roleAllowed = allowedRoles.includes(target.role);
        const deptAllowed = !viewerDepartment || target.department === viewerDepartment;
        if (!roleAllowed || !deptAllowed) {
          return res.status(403).json({ error: 'Bu kişinin verilerine erişim yetkiniz yok.' });
        }
      }

      const tasksResult = await db.execute({
        sql: `SELECT id, title, assigned_to, category, end_date, status FROM tasks WHERE assigned_to = ?`,
        args: [userId]
      });

      const logsResult = await db.execute({
        sql: `SELECT daily_logs.id, daily_logs.intern_id, users.name as intern_name, daily_logs.task_id, tasks.title as task_title, daily_logs.log_date, daily_logs.note
              FROM daily_logs
              LEFT JOIN users ON daily_logs.intern_id = users.id
              LEFT JOIN tasks ON daily_logs.task_id = tasks.id
              WHERE daily_logs.intern_id = ?
              ORDER BY daily_logs.log_date ASC`,
        args: [userId]
      });

      return res.json({ people, tasks: tasksResult.rows, logs: logsResult.rows });
    }

    let userSql = `SELECT id, name, role, department FROM users WHERE status = 'APPROVED'`;
    const userArgs = [];
    const conditions = [];

    const deptList = (departments || '').split(',').map(d => d.trim()).filter(Boolean);
    let roleList = (roles || '').split(',').map(r => r.trim()).filter(Boolean);

    // ADMIN değilse: sadece kendi biriminden ve yalnızca kendi altındaki rolleri görebilir
    if (!isAdmin(userRole)) {
      const allowedRoles = getSubordinateRoles(userRole);

      // Talep edilen roller varsa, izin verilenlerle kesişimini al; yoksa tüm izin verilenleri kullan
      if (roleList.length > 0) {
        roleList = roleList.filter(r => allowedRoles.includes(r));
      } else {
        roleList = allowedRoles;
      }

      // Görünürlük kendi birimiyle sınırlı
      if (viewerDepartment) {
        conditions.push(`department = ?`);
        userArgs.push(viewerDepartment);
      }
    }

    if (deptList.length > 0) {
      conditions.push(`department IN (${deptList.map(() => '?').join(',')})`);
      userArgs.push(...deptList);
    }
    if (roleList.length > 0) {
      conditions.push(`role IN (${roleList.map(() => '?').join(',')})`);
      userArgs.push(...roleList);
    }

    if (conditions.length > 0) {
      userSql += ` AND ` + conditions.join(' AND ');
    }

    userSql += ` ORDER BY name ASC`;

    const usersResult = await db.execute({ sql: userSql, args: userArgs });
    const people = usersResult.rows;

    if (people.length === 0) {
      return res.json({ people: [], tasks: [], logs: [] });
    }

    const ids = people.map(p => p.id);
    const placeholders = ids.map(() => '?').join(',');

    const tasksResult = await db.execute({
      sql: `SELECT id, title, assigned_to, category, end_date, status FROM tasks WHERE assigned_to IN (${placeholders})`,
      args: ids
    });

    const logsResult = await db.execute({
      sql: `SELECT daily_logs.id, daily_logs.intern_id, users.name as intern_name, daily_logs.task_id, tasks.title as task_title, daily_logs.log_date, daily_logs.note
            FROM daily_logs
            LEFT JOIN users ON daily_logs.intern_id = users.id
            LEFT JOIN tasks ON daily_logs.task_id = tasks.id
            WHERE daily_logs.intern_id IN (${placeholders})
            ORDER BY daily_logs.log_date ASC`,
      args: ids
    });

    res.json({ people, tasks: tasksResult.rows, logs: logsResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Toplantı Talebini Onaylama / Reddetme (Sadece Müdür/Ekip Lideri kendi birimi, veya Admin)
app.put('/api/meetings/:id/review', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const { action, reviewComment, userRole, reviewerName, department } = req.body;

    if (!['MANAGER', 'LEADER', 'ADMIN'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    if (!['APPROVED', 'REJECTED'].includes(action)) {
      return res.status(400).json({ error: 'Geçersiz işlem.' });
    }

    // Rol seviyesi kontrolü: İnceleyen kişi, talep edenden DAHA DÜŞÜK roldeyse yetkisi yoktur.
    // (Örn. bir ekip lideri, müdürün oluşturduğu talebi onaylayamaz/reddedemez.) ADMIN hiyerarşi dışıdır.
    if (userRole !== 'ADMIN') {
      const reqRes = await db.execute({
        sql: `SELECT users.role AS requester_role FROM meeting_requests
              LEFT JOIN users ON meeting_requests.requested_by = users.id
              WHERE meeting_requests.id = ?`,
        args: [meetingId]
      });

      if (reqRes.rows.length === 0) {
        return res.status(404).json({ error: 'Talep bulunamadı.' });
      }

      const requesterRole = reqRes.rows[0].requester_role;
      const reqIdx = ROLE_HIERARCHY.indexOf(requesterRole);
      const myIdx = ROLE_HIERARCHY.indexOf(userRole);

      // Index küçük = daha yüksek rol. İnceleyen (myIdx) talep edene (reqIdx) eşit veya daha yüksek
      // rolde olmalı => myIdx <= reqIdx. Aksi halde (inceleyen daha düşük rolde) yetki yok.
      if (reqIdx === -1 || myIdx === -1 || myIdx > reqIdx) {
        return res.status(403).json({ error: 'Bu talebi onaylama/reddetme yetkiniz yok.' });
      }
    }

    // Müdür/Ekip Lideri sadece kendi biriminin talebini onaylayabilir
    let sql = `UPDATE meeting_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE id = ?`;
    let args = [action, reviewerName || null, reviewComment || null, meetingId];

    if (userRole !== 'ADMIN') {
      sql = `UPDATE meeting_requests SET status = ?, reviewed_by = ?, review_comment = ? WHERE id = ? AND department = ?`;
      args = [action, reviewerName || null, reviewComment || null, meetingId, department];
    }

    const result = await db.execute({ sql, args });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Talep bulunamadı veya bu talebe erişim yetkiniz yok.' });
    }

    res.json({ message: action === 'APPROVED' ? 'Toplantı talebi onaylandı.' : 'Toplantı talebi reddedildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Talep güncellenirken hata: ' + error.message });
  }
});

// ===== AI İŞ PLANI ENDPOINT'LERİ =====

// Yetki yardımcısı: iş planı oluşturabilen roller
const IS_PLANI_YETKILI = ['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'];

// 1) Plan üret (6 adıma böler + AI açıklaması) — DB'ye yazmaz
app.post('/api/is-plani', async (req, res) => {
  try {
    const { kartIsmi, kategori, dokumanTarihi, bitisTarihi, userRole } = req.body;

    if (!IS_PLANI_YETKILI.includes(userRole)) {
      return res.status(403).json({ error: 'İş planı oluşturma yetkiniz yok.' });
    }
    if (!kartIsmi || !kategori || !dokumanTarihi || !bitisTarihi) {
      return res.status(400).json({ error: 'Kart ismi, kategori, döküman ve bitiş tarihi gereklidir.' });
    }

    const agirliklar = await akilliAgirliklarHesapla(Number(kategori));
    const plan = isPlaniHesapla(Number(kategori), dokumanTarihi, bitisTarihi, agirliklar);

    const gecmisNotlari = plan.adimlar
      .filter(a => a.kaynak === 'gercek' && a.gecmisAdet > 0)
      .map(a => `${a.ad}: geçmişte ortalama ${a.gun} gün sürmüş (${a.gecmisAdet} kayıt)`)
      .join('\n');
    const gecmisBolumu = gecmisNotlari
      ? `\nGEÇMİŞ VERİLER (dikkate al):\n${gecmisNotlari}\n` : '';

    const prompt = `Sen bir proje mühendisliği asistanısın. "${kartIsmi}" adlı iş için aşağıdaki aşamaların her birine, o aşamada ne yapılacağını anlatan TEK cümlelik kısa bir açıklama yaz.

ÇOK ÖNEMLİ KURALLAR:
- SADECE Türkçe yaz. Kesinlikle Çince, İngilizce veya başka bir dil kullanma.
- Her açıklama en fazla 15 kelime olsun.
- Markdown veya işaret kullanma.
${gecmisBolumu}
Aşamalar: ${plan.adimlar.map(a => a.ad).join(', ')}

SADECE şu formatta, her aşama için bir satır:
${plan.adimlar.map(a => `${a.ad}: <açıklama>`).join('\n')}`;

    let aciklamalar = {};
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5',
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { temperature: 0.3 }
        })
      });
      if (response.ok) {
        const data = await response.json();
        const metin = data.message.content.trim();
        metin.split('\n').forEach(satir => {
          const idx = satir.indexOf(':');
          if (idx > -1) {
            aciklamalar[satir.slice(0, idx).trim()] = satir.slice(idx + 1).trim();
          }
        });
      }
    } catch (aiErr) {
      console.error('AI açıklama hatası:', aiErr.message);
    }

    plan.adimlar = plan.adimlar.map(adim => ({ ...adim, aciklama: aciklamalar[adim.ad] || '' }));

    res.json({ kartIsmi, kategori: Number(kategori), ...plan });
  } catch (error) {
    res.status(500).json({ error: 'İş planı üretilemedi: ' + error.message });
  }
});

// 2) Planı görevin is_plani sütununa kaydet
app.post('/api/tasks/:id/is-plani-kaydet', async (req, res) => {
  try {
    const { plan, userRole } = req.body;
    if (!IS_PLANI_YETKILI.includes(userRole)) {
      return res.status(403).json({ error: 'İş planı kaydetme yetkiniz yok.' });
    }
    await db.execute({
      sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`,
      args: [JSON.stringify(plan), req.params.id]
    });
    res.json({ message: 'İş planı kaydedildi.' });
  } catch (error) {
    res.status(500).json({ error: 'İş planı kaydedilemedi: ' + error.message });
  }
});
// Görevin iş planını sil (geçmiş verilere DOKUNMAZ)
app.post('/api/tasks/:id/is-plani-sil', async (req, res) => {
  try {
    const { userRole } = req.body;
    if (!IS_PLANI_YETKILI.includes(userRole)) {
      return res.status(403).json({ error: 'İş planı silme yetkiniz yok.' });
    }
    await db.execute({
      sql: `UPDATE tasks SET is_plani = NULL WHERE id = ?`,
      args: [req.params.id]
    });
    res.json({ message: 'İş planı sıfırlandı.' });
  } catch (error) {
    res.status(500).json({ error: 'İş planı sıfırlanamadı: ' + error.message });
  }
});
// Planı güncelle: biten aşamalar korunur, kalanlar yeni bitişe göre yeniden hesaplanır
app.post('/api/tasks/:id/is-plani-guncelle', async (req, res) => {
  try {
    const { yeniBitis, userRole } = req.body;
    if (!IS_PLANI_YETKILI.includes(userRole)) {
      return res.status(403).json({ error: 'İş planı güncelleme yetkiniz yok.' });
    }
    if (!yeniBitis) return res.status(400).json({ error: 'Yeni bitiş tarihi gereklidir.' });

    const taskResult = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [req.params.id] });
    const task = taskResult.rows[0];
    if (!task || !task.is_plani) return res.status(404).json({ error: 'Görev veya iş planı bulunamadı.' });

    const plan = JSON.parse(task.is_plani);

    // "GG.AA.YYYY" -> Date
    const parseTR = (s) => { const [g,a,y] = s.split('.').map(Number); return new Date(y, a-1, g); };
    const fmt = (d) => {
      const g = String(d.getDate()).padStart(2,'0');
      const a = String(d.getMonth()+1).padStart(2,'0');
      return `${g}.${a}.${d.getFullYear()}`;
    };

    // Biten ve kalan aşamaları ayır
    const bitenler = plan.adimlar.filter(a => a.durum === 'bitti');
    const kalanlar = plan.adimlar.filter(a => a.durum !== 'bitti');

    if (kalanlar.length === 0) {
      return res.status(400).json({ error: 'Tüm aşamalar tamamlanmış, güncellenecek aşama yok.' });
    }

    // Kalan aşamalar hangi tarihten başlayacak: son biten aşamanın bitişi (yoksa planın başı)
    let baslangic;
    if (bitenler.length > 0) {
      baslangic = parseTR(bitenler[bitenler.length - 1].bitis);
    } else {
      baslangic = parseTR(plan.adimlar[0].baslangic);
    }

    const bitis = new Date(yeniBitis);
    if (bitis <= baslangic) {
      return res.status(400).json({ error: 'Yeni bitiş tarihi, tamamlanan son aşamanın bitişinden sonra olmalı.' });
    }

    // Kalan aşamaların orijinal yüzdelerini bul (IS_ADIMLARI'ndan)
    const kalanToplamGun = Math.max(1, Math.round((bitis - baslangic) / (1000*60*60*24)));
    const kalanYuzdeToplam = kalanlar.reduce((t, a) => {
      const def = IS_ADIMLARI.find(x => x.ad === a.ad);
      return t + (def ? def.yuzde : 0);
    }, 0);

    // Kalanları yeniden tarihle
    let imlec = new Date(baslangic);
    const yeniKalanlar = kalanlar.map(a => {
      const def = IS_ADIMLARI.find(x => x.ad === a.ad);
      const oran = def ? def.yuzde : 0;
      const gun = Math.round(kalanToplamGun * oran / kalanYuzdeToplam);
      const bas = new Date(imlec);
      const bit = new Date(imlec);
      bit.setDate(bit.getDate() + gun);
      imlec = new Date(bit);
      return { ...a, baslangic: fmt(bas), bitis: fmt(bit), gun };
    });

    // Yeni plan: biten aşamalar aynen + yeniden hesaplanan kalanlar (orijinal sırada)
    const yeniAdimlar = plan.adimlar.map(a => {
      if (a.durum === 'bitti') return a;
      return yeniKalanlar.find(k => k.ad === a.ad) || a;
    });

    plan.adimlar = yeniAdimlar;
    plan.bitis = fmt(bitis);
    // toplamGun: ilk aşamanın başından yeni bitişe
    const planBas = parseTR(plan.adimlar[0].baslangic);
    plan.toplamGun = Math.max(1, Math.round((bitis - planBas) / (1000*60*60*24)));

    await db.execute({ sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`, args: [JSON.stringify(plan), req.params.id] });
    res.json({ message: 'İş planı güncellendi.', plan });
  } catch (error) {
    res.status(500).json({ error: 'İş planı güncellenemedi: ' + error.message });
  }
});
// ===== BİLDİRİM SİSTEMİ =====

// Gecikme kontrolü: panel açılınca çağrılır, geciken aşamalar için bildirim üretir
// (aynı aşama için tekrar bildirim üretmez)
app.post('/api/bildirimler/gecikme-kontrol', async (req, res) => {
  try {
    const bugun = new Date(); bugun.setHours(0,0,0,0);
    const bugunStr = new Date().toISOString().split('T')[0];

    // Planı olan tüm görevleri çek
    const tasksResult = await db.execute(`SELECT id, title, is_plani, created_by, assigned_to FROM tasks WHERE is_plani IS NOT NULL`);

    const parseTR = (s) => { const [g,a,y] = s.split('.').map(Number); return new Date(y, a-1, g); };

    for (const task of tasksResult.rows) {
      let plan;
      try { plan = JSON.parse(task.is_plani); } catch (e) { continue; }
      if (!plan.adimlar) continue;

      // created_by kimin? (görevi veren) — users tablosundan id bul
      // created_by isim/eposta olabilir; güvenli olması için önce eşleşmeyi deneriz
      let hedefUserId = null;
      const uRes = await db.execute({
        sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
        args: [task.created_by, task.created_by]
      });
      if (uRes.rows[0]) hedefUserId = uRes.rows[0].id;
      if (!hedefUserId) continue; // görevi vereni bulamadıysak atla

      // Aşamaları kontrol et: bitmemiş + planlanan bitişi geçmiş = gecikmiş
      for (let i = 0; i < plan.adimlar.length; i++) {
        const a = plan.adimlar[i];
        if (a.durum === 'bitti') continue;
        const bit = parseTR(a.bitis);
        if (bugun > bit) {
          // Bu aşama için daha önce bildirim üretilmiş mi?
          const varMi = await db.execute({
            sql: `SELECT id FROM notifications WHERE task_id = ? AND tip = ? LIMIT 1`,
            args: [task.id, `gecikme_${i}`]
          });
          if (varMi.rows.length === 0) {
            const gecenGun = Math.round((bugun - bit) / (1000*60*60*24));
            await db.execute({
              sql: `INSERT INTO notifications (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
              args: [hedefUserId, task.id, `gecikme_${i}`,
                     `"${task.title}" görevinde "${a.ad}" aşaması gecikti (${gecenGun} gündür bekliyor).`, bugunStr]
            });
          }
        }
      }
    }

    res.json({ message: 'Gecikme kontrolü tamamlandı.' });
  } catch (error) {
    res.status(500).json({ error: 'Gecikme kontrolü hatası: ' + error.message });
  }
});

// Kullanıcının bildirimlerini getir (en yeni önce)
app.get('/api/bildirimler', async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await db.execute({
      sql: `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      args: [userId]
    });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bildirimi okundu işaretle (tek bildirim ya da hepsi)
app.post('/api/bildirimler/okundu', async (req, res) => {
  try {
    const { bildirimId, userId, hepsi } = req.body;
    if (hepsi) {
      await db.execute({ sql: `UPDATE notifications SET okundu = 1 WHERE user_id = ?`, args: [userId] });
    } else if (bildirimId) {
      await db.execute({ sql: `UPDATE notifications SET okundu = 1 WHERE id = ?`, args: [bildirimId] });
    }
    res.json({ message: 'Okundu işaretlendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== BİLDİRİM SİSTEMİ SONU =====
// 3) Aşama durumu: stajyer bitirme talebi -> görevi verenin onayı -> bitti
app.post('/api/tasks/:id/asama-durum', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { asamaIndex, islem, kullanici, userId, userRole, gercekBaslangic, gercekBitis } = req.body;

    const taskResult = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [taskId] });
    const task = taskResult.rows[0];
    if (!task || !task.is_plani) {
      return res.status(404).json({ error: 'Görev veya iş planı bulunamadı.' });
    }

    const plan = JSON.parse(task.is_plani);
    const asama = plan.adimlar[asamaIndex];
    if (!asama) return res.status(400).json({ error: 'Geçersiz aşama.' });

    const bugun = new Date().toISOString().split('T')[0];
    // Onay yetkisi: görevi veren kişi (isim eşleşmesi) veya yönetici roller
    const yoneticiRol = ['ADMIN', 'MANAGER', 'LEADER'].includes(userRole);
    const onaylayabilir = (kullanici && task.created_by && kullanici === task.created_by) || yoneticiRol;

    if (islem === 'bitir') {
      // Stajyer bitirme TALEBİ -> onay bekliyor
      if (Number(userId) !== Number(task.assigned_to)) {
        return res.status(403).json({ error: 'Bu aşamayı yalnızca göreve atanan kişi tamamlayabilir.' });
      }
      // Girilen gerçek tarihleri "bekleyen" olarak sakla (onaylanınca kesinleşecek)
      let bekBas = gercekBaslangic;
      if (!bekBas) { const [g, a, y] = asama.baslangic.split('.'); bekBas = `${y}-${a}-${g}`; }
      asama.durum = 'onay_bekliyor';
      asama.bekleyenBaslangic = bekBas;
      asama.bekleyenBitis = gercekBitis || bugun;
      asama.talepEden = kullanici || null;

      // Görevi verene bildirim gönder
      try {
        const hedef = await db.execute({
          sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
          args: [task.created_by, task.created_by]
        });
        const hedefId = hedef.rows[0] && hedef.rows[0].id;
        if (hedefId) {
          await db.execute({
            sql: `INSERT INTO notifications (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
            args: [hedefId, taskId, 'asama_onay',
              `"${task.title}" görevinde "${asama.ad}" aşaması tamamlandı, onayınızı bekliyor.`, bugun]
          });
        }
      } catch (e) { console.error('Onay bildirimi hatası:', e.message); }

    } else if (islem === 'onayla') {
      // Görevi veren ONAYLAR -> bitti
      if (!onaylayabilir) return res.status(403).json({ error: 'Bu aşamayı yalnızca görevi veren kişi onaylayabilir.' });
      if (asama.durum !== 'onay_bekliyor') return res.status(400).json({ error: 'Bu aşama onay beklemiyor.' });

      asama.durum = 'bitti';
      asama.gercekBaslangic = asama.bekleyenBaslangic;
      asama.gercekBitis = asama.bekleyenBitis;
      delete asama.bekleyenBaslangic; delete asama.bekleyenBitis; delete asama.talepEden;

      const bas = new Date(asama.gercekBaslangic);
      const bit = new Date(asama.gercekBitis);
      const gercekGun = Math.max(1, Math.round((bit - bas) / (1000 * 60 * 60 * 24)));
      await db.execute({
        sql: `INSERT INTO asama_gecmisi (task_id, asama_adi, kategori, tahmini_gun, gercek_gun, baslangic, bitis, kaydeden, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [taskId, asama.ad, plan.kategori || null, asama.gun || null, gercekGun,
               asama.gercekBaslangic, asama.gercekBitis, kullanici || 'Bilinmiyor', bugun]
      });

    } else if (islem === 'reddet') {
      // Görevi veren REDDEDER -> tekrar devam durumuna döner
      if (!onaylayabilir) return res.status(403).json({ error: 'Bu işlemi yalnızca görevi veren kişi yapabilir.' });
      if (asama.durum !== 'onay_bekliyor') return res.status(400).json({ error: 'Bu aşama onay beklemiyor.' });

      const talepEden = asama.talepEden;
      asama.durum = 'devam';
      delete asama.bekleyenBaslangic; delete asama.bekleyenBitis; delete asama.talepEden;

      // Talep eden stajyere bildirim gönder
      try {
        const hedef = await db.execute({
          sql: `SELECT id FROM users WHERE name = ? OR email = ? LIMIT 1`,
          args: [talepEden, talepEden]
        });
        const hedefId = hedef.rows[0] && hedef.rows[0].id;
        if (hedefId) {
          await db.execute({
            sql: `INSERT INTO notifications (user_id, task_id, tip, mesaj, okundu, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
            args: [hedefId, taskId, 'asama_red',
              `"${task.title}" görevinde "${asama.ad}" aşaması onaylanmadı, lütfen tekrar kontrol edin.`, bugun]
          });
        }
      } catch (e) { console.error('Red bildirimi hatası:', e.message); }

    } else {
      return res.status(400).json({ error: 'Geçersiz işlem.' });
    }

    await db.execute({ sql: `UPDATE tasks SET is_plani = ? WHERE id = ?`, args: [JSON.stringify(plan), taskId] });
    res.json({ message: 'Aşama durumu güncellendi.', plan });
  } catch (error) {
    res.status(500).json({ error: 'Aşama durumu güncellenemedi: ' + error.message });
  }
});
// ===== AI İŞ PLANI ENDPOINT'LERİ SONU =====

// ===== GÖREV ASİSTANI (CHATBOT) =====
// Kullanıcının görebildiği görevleri bağlam olarak LLM'e verir, serbest sohbetle yanıtlar.
app.post('/api/chatbot', async (req, res) => {
  try {
    const { userId, role, department, message, history } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Mesaj boş olamaz.' });
    }

    // Kullanıcının görebileceği görevleri çek (GET /api/tasks ile aynı yetki mantığı)
    let sql = `SELECT tasks.*, users.name as assignee_name FROM tasks LEFT JOIN users ON tasks.assigned_to = users.id`;
    const conditions = [], args = [];
    if (role === 'INTERN') { conditions.push(`tasks.assigned_to = ?`); args.push(userId); }
    else if (role !== 'ADMIN' && department) { conditions.push(`users.department = ?`); args.push(department); }
    if (conditions.length) sql += ` WHERE ` + conditions.join(' AND ');
    sql += ` ORDER BY tasks.id DESC LIMIT 100`;
    const result = await db.execute({ sql, args });
    const tasks = result.rows;

    // Görevleri LLM için sade metne çevir
    const bugunStr = new Date().toISOString().split('T')[0];
    const bugunD = new Date(); bugunD.setHours(0, 0, 0, 0);
    const parseTR = (s) => { const [g, a, y] = String(s).split('.').map(Number); return new Date(y, a - 1, g); };
    const durumTR = {
      IN_PROGRESS: 'Devam ediyor', COMPLETED: 'Tamamlandı (onay bekliyor)',
      APPROVED: 'Onaylandı', REVISION_REQUESTED: 'Revize istendi'
    };

    const gorevMetni = tasks.map(t => {
      let planBilgi = '';
      if (t.is_plani) {
        try {
          const plan = JSON.parse(t.is_plani);
          if (plan && Array.isArray(plan.adimlar)) {
            const toplam = plan.adimlar.length;
            const biten = plan.adimlar.filter(a => a.durum === 'bitti').length;
            const gecikenAd = plan.adimlar
              .filter(a => a.durum !== 'bitti' && a.bitis && parseTR(a.bitis) < bugunD)
              .map(a => a.ad);
            planBilgi = ` | Plan: ${biten}/${toplam} aşama tamamlandı` +
              (gecikenAd.length ? `, geciken aşamalar: ${gecikenAd.join(', ')}` : '');
          }
        } catch (e) {}
      }
      return `- "${t.title}" | Atanan: ${t.assignee_name || '?'} | Görevi veren: ${t.created_by || '?'} | Kategori: ${t.category} | Başlangıç: ${t.start_date || 'belirtilmemiş'} | Bitiş: ${t.end_date} | Durum: ${durumTR[t.status] || t.status}${planBilgi}`;
    }).join('\n');

    const sistem = `Sen "Görevlendirme ve Takip Paneli" adlı uygulamanın görev asistanısın. Kullanıcının görevleriyle ilgili sorularını SADECE aşağıdaki verilere dayanarak yanıtla. Bugünün tarihi: ${bugunStr}.

KURALLAR:
- SADECE Türkçe yaz. Kısa, net ve yardımcı ol; gerektiğinde madde madde listele.
- Yalnızca aşağıdaki verilere dayan. Veride olmayan bir şey sorulursa uydurma, "Bu bilgi elimde yok." de.
- Tarih, sayı ve durum sorularında verideki değerleri kullan.
- Kullanıcının rolü: ${role || 'bilinmiyor'}.

GÖREV VERİLERİ (${tasks.length} görev):
${gorevMetni || 'Görev bulunmuyor.'}`;

    const messages = [{ role: 'system', content: sistem }];
    if (Array.isArray(history)) {
      history.slice(-8).forEach(h => {
        if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
          messages.push({ role: h.role, content: String(h.content).slice(0, 2000) });
        }
      });
    }
    messages.push({ role: 'user', content: String(message).slice(0, 2000) });

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5', messages, stream: false, options: { temperature: 0.4 } })
    });
    if (!response.ok) throw new Error('Yapay zekâ servisi yanıt vermedi (' + response.status + ').');
    const data = await response.json();
    const cevap = (data && data.message && data.message.content ? data.message.content : '').trim();
    res.json({ reply: cevap || 'Üzgünüm, şu an bir yanıt üretemedim.' });
  } catch (error) {
    res.status(500).json({ error: 'Asistan hatası: ' + error.message });
  }
});
// ===== GÖREV ASİSTANI SONU =====

// ===== GENEL ASİSTAN (LLM ile serbest sohbet) =====
app.post('/api/asistan', async (req, res) => {
  try {
    const { userId, role, name, department, messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Mesaj gerekli.' });
    }

    // Kullanıcının görebileceği görevleri topla (kendine atanan + kendi verdiği)
    let tasks = [];
    try {
      const r = await db.execute({
        sql: `SELECT t.*, u.name AS assignee_name
              FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
              WHERE t.assigned_to = ? OR t.created_by = ?
              ORDER BY t.id DESC LIMIT 60`,
        args: [userId, name]
      });
      tasks = r.rows;
    } catch (e) { /* veri yoksa boş geç */ }

    const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
    const parseTR = (s) => { try { const [g, a, y] = s.split('.').map(Number); return new Date(y, a - 1, g); } catch (e) { return null; } };
    const durumTR = { IN_PROGRESS: 'Devam ediyor', COMPLETED: 'Tamamlandı (onay bekliyor)', APPROVED: 'Onaylandı', REVISION_REQUESTED: 'Revize istendi' };

    const gorevMetni = tasks.map(t => {
      let plan = null;
      try { plan = t.is_plani ? JSON.parse(t.is_plani) : null; } catch (e) {}
      let planBilgi = '';
      if (plan && plan.adimlar) {
        const biten = plan.adimlar.filter(a => a.durum === 'bitti').length;
        const geciken = plan.adimlar
          .filter((a) => a.durum !== 'bitti' && parseTR(a.bitis) && parseTR(a.bitis) < bugun)
          .map(a => a.ad);
        planBilgi = ` | Plan: ${biten}/${plan.adimlar.length} aşama bitti` + (geciken.length ? `; geciken aşama(lar): ${geciken.join(', ')}` : '');
      }
      return `- "${t.title}" | Atanan: ${t.assignee_name || '?'} | Durum: ${durumTR[t.status] || t.status} | Başlangıç: ${t.start_date || '?'} | Son teslim: ${t.end_date} | Kategori: ${t.category}${planBilgi}`;
    }).join('\n') || 'Bu kullanıcıya ait kayıtlı görev yok.';

    const bugunStr = new Date().toISOString().split('T')[0];
    const sistem = `Sen "Görevlendirme ve Takip Paneli" uygulamasının Türkçe yardımcı asistanısın.
Kullanıcı: ${name} (rol: ${role}${department ? ', birim: ' + department : ''}). Bugünün tarihi: ${bugunStr}.
Aşağıda bu kullanıcıyla ilgili GÜNCEL görev verileri var. Soruları SADECE bu verilere ve genel bilgine dayanarak yanıtla.
Veride olmayan bir şeyi uydurma; bilmiyorsan "Bu bilgi elimde yok" de. Kısa, net ve Türkçe yanıt ver. Markdown/işaret kullanma.

GÖREV VERİLERİ:
${gorevMetni}`;

    const sonMesajlar = messages.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '')
    }));
    const ollamaMesajlar = [{ role: 'system', content: sistem }, ...sonMesajlar];

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5', messages: ollamaMesajlar, stream: false, options: { temperature: 0.4 } })
    });
    if (!response.ok) throw new Error('LLM yanıt vermedi (' + response.status + ')');
    const data = await response.json();
    const cevap = (data.message && data.message.content ? data.message.content : '').trim() || 'Üzgünüm, bir yanıt üretemedim.';
    res.json({ cevap });
  } catch (error) {
    res.status(500).json({ error: 'Asistan hatası: ' + error.message });
  }
});

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});