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

    console.log('Turso bulut veritabanı tabloları hazır.');
  } catch (err) {
    console.error('Veritabanı başlatma hatası:', err.message);
  }
}

initDb();

// --- API ENDPOINT'LERİ ---

// Kayıt Ol
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role, startDate, endDate } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun!' });
    }

    if (role === 'INTERN' && (!startDate || !endDate)) {
      return res.status(400).json({ error: 'Stajyerler için başlangıç ve bitiş tarihleri zorunludur!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.execute({
      sql: `INSERT INTO users (name, email, password, role, intern_start_date, intern_end_date) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [name, email, hashedPassword, role, role === 'INTERN' ? startDate : null, role === 'INTERN' ? endDate : null]
    });

    res.json({ message: 'Kullanıcı başarıyla oluşturuldu.', userId: Number(result.lastInsertRowid) });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı!' });
    }
    res.status(500).json({ error: 'Veritabanı hatası: ' + error.message });
  }
});

// Giriş Yap
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.execute({
      sql: `SELECT * FROM users WHERE email = ?`,
      args: [email]
    });

    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Kullanıcı bulunamadı.' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Hatalı şifre!' });

    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
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
    const result = await db.execute(`SELECT id, name, email, role, intern_start_date, intern_end_date FROM users`);
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
            htmlContent: `<p>Merhaba ${intern.name}, ${createdBy} tarafından tarafınıza yeni bir görev atandı: <strong>${title}</strong></p>`
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

// Görevleri Getirme
app.get('/api/tasks', async (req, res) => {
  try {
    const { userId, role } = req.query;
    let sql = `SELECT tasks.*, users.name as assignee_name FROM tasks JOIN users ON tasks.assigned_to = users.id`;
    let args = [];

    if (role === 'INTERN') {
      sql += ` WHERE tasks.assigned_to = ?`;
      args.push(userId);
    }

    const result = await db.execute({ sql, args });
    res.json(result.rows);
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
                <div style="background-color: #0f172a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px 20px; color: #f8fafc;">
                  <div style="max-width: 600px; margin: 0 auto; background-color: #1e293b; border-radius: 16px; border: 1px solid #334155; padding: 32px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);">
                    
                    <!-- Header & Logo -->
                    <div style="text-align: center; margin-bottom: 28px;">
                      <img src="${companyLogoUrl}" alt="Logo" style="height: 48px; width: auto; margin-bottom: 12px;" />
                      <h2 style="color: #38bdf8; margin: 0; font-size: 20px; font-weight: 700; tracking-tight;">Görev Tamamlandı Bildirimi</h2>
                    </div>

                    <!-- Main Content -->
                    <p style="font-size: 15px; line-height: 1.6; color: #cbd5e1; margin-bottom: 20px;">
                      Merhaba <strong style="color: #ffffff;">${creator.name}</strong>,
                    </p>
                    <p style="font-size: 15px; line-height: 1.6; color: #cbd5e1; margin-bottom: 24px;">
                      <strong style="color: #38bdf8;">${task.intern_name}</strong> isimli stajyer kendisine atanan görevi tamamlandı olarak işaretledi. Detaylar aşağıda yer almaktadır:
                    </p>

                    <!-- Details Card -->
                    <div style="background-color: #0f172a; border-radius: 12px; border: 1px solid #334155; padding: 20px; margin-bottom: 28px;">
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
                        Paneli İncele ve Onayla
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

// Geliştirme 2: Görev İnceleme & Onay/Revize Mekanizması
app.put('/api/tasks/:id/review', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { action, comment, userRole } = req.body; // action: 'APPROVE' or 'REVISE'

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REVISION_REQUESTED';

    const result = await db.execute({
      sql: `UPDATE tasks SET status = ?, review_comment = ? WHERE id = ?`,
      args: [newStatus, comment || null, taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: action === 'APPROVE' ? 'Görev onaylandı.' : 'Görev revizeye gönderildi.', status: newStatus });
  } catch (error) {
    res.status(500).json({ error: 'Onay/Revize işlemi gerçekleştirilemedi: ' + error.message });
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

// Görev Silme
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const userRole = req.headers['user-role'];

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    await db.execute({ sql: `DELETE FROM daily_logs WHERE task_id = ?`, args: [taskId] });
    const result = await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [taskId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    res.json({ message: 'Görev başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev silinirken hata oluştu: ' + error.message });
  }
});

// Stajyer Silme
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
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

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
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

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
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

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});