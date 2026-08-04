const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Turso Bulut Veritabanı Bağlantısı
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
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
        FOREIGN KEY(requested_by) REFERENCES users(id)
      )
    `);

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
    const { title, description, assignedTo, category, endDate, workDays, createdBy } = req.body;

    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, description || '', assignedTo, category, endDate, workDays, createdBy]
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
    const { newRole, adminRole } = req.body;

    if (!isAdmin(adminRole)) {
      return res.status(403).json({ error: 'Yetkisiz işlem.' });
    }

    await db.execute({
      sql: `UPDATE users SET role = ? WHERE id = ?`,
      args: [newRole, userId]
    });

    res.json({ message: 'Kullanıcı rolü güncellendi.' });
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

    await db.execute({
      sql: `DELETE FROM users WHERE id = ?`,
      args: [userId]
    });

    res.json({ message: 'Kullanıcı sistemden silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// Geliştirme 2: Yeni Görev Oluşturma & Brevo ile Stajyere Mail Bildirimi
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, category, deadline, assignedTo, createdBy } = req.body;

    if (!title || !category || !deadline || !assignedTo || !createdBy) {
      return res.status(400).json({ error: 'Lütfen gerekli tüm alanları doldurun.' });
    }

    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, category, deadline, assigned_to, created_by, status) 
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      args: [title, description || '', category, deadline, assignedTo, createdBy]
    });

    // Görev atanan stajyerin bilgilerini al
    const userRes = await db.execute({
      sql: `SELECT email, name FROM users WHERE id = ?`,
      args: [assignedTo]
    });
    const intern = userRes.rows[0];

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
              <div style="background-color: #f8fafc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #0f172a;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);">
                  
                  <!-- Header & Logo -->
                  <div style="text-align: center; margin-bottom: 28px;">
                    <img src="${companyLogoUrl}" alt="Logo" style="height: 48px; width: auto; margin-bottom: 12px;" />
                    <h2 style="color: #0284c7; margin: 0; font-size: 20px; font-weight: 700;">Yeni Görev Bildirimi</h2>
                  </div>

                  <!-- Main Content -->
                  <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 20px;">
                    Merhaba <strong style="color: #0f172a;">${intern.name}</strong>,
                  </p>
                  <p style="font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 24px;">
                    <strong style="color: #0284c7;">${createdBy}</strong> tarafından size yeni bir görev atandı. Görev detayları aşağıda yer almaktadır:
                  </p>

                  <!-- Details Card (Koyu Bilgi Alanı) -->
                  <div style="background-color: #0f172a; border-radius: 12px; border: 1px solid #1e293b; padding: 20px; margin-bottom: 28px;">
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
                        <td style="padding: 6px 0; color: #94a3b8;">Son Tarih:</td>
                        <td style="padding: 6px 0; color: #38bdf8; font-weight: 600;">${deadline}</td>
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
                      Görev Detaylarına Git
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
        console.error('Mail gönderme hatası:', mailErr);
      }
    }

    res.status(201).json({ id: result.lastInsertRowid.toString(), message: 'Görev başarıyla eklendi ve bildirim maili gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev eklenirken bir hata oluştu: ' + error.message });
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

    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
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
    const { title, description, assignedTo, category, endDate, workDays, userRole } = req.body;

    if (!['ADMIN', 'MANAGER', 'LEADER', 'ENGINEER'].includes(userRole)) {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ? WHERE id = ?`,
      args: [title, description || '', assignedTo, category, endDate, workDays, taskId]
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
    const { requestedBy, subject, description, preferredDate, userRole } = req.body;

    if (!['ENGINEER', 'LEADER', 'MANAGER'].includes(userRole)) {
      return res.status(403).json({ error: 'Toplantı talebi oluşturmak için yetkiniz yok.' });
    }

    if (!requestedBy || !subject) {
      return res.status(400).json({ error: 'Talep eden kullanıcı ve konu alanı zorunludur.' });
    }

    // Talep edenin birimini güvenlik için veritabanından doğrula
    const userResult = await db.execute({
      sql: `SELECT department FROM users WHERE id = ?`,
      args: [requestedBy]
    });

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const department = userResult.rows[0].department;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const result = await db.execute({
      sql: `INSERT INTO meeting_requests (requested_by, department, subject, description, preferred_date, status, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
      args: [requestedBy, department || null, subject, description || null, preferredDate || null, now]
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
      // Müdür/Ekip Lideri sadece kendi biriminden gelen talepleri görür
      conditions.push(`meeting_requests.department = ?`);
      args.push(department);
    } else if (role === 'ADMIN') {
      // Admin tüm talepleri görebilir, ek filtre yok
    } else {
      // Diğer roller (ör. Mühendis) sadece kendi taleplerini görür
      conditions.push(`meeting_requests.requested_by = ?`);
      args.push(userId);
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

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});