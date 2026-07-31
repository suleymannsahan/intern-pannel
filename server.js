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
        FOREIGN KEY(assigned_to) REFERENCES users(id)
      )
    `);

    // Eğer tablo önceden 'description' olmadan oluşturulduysa sütunu ekler
    try {
      await db.execute(`ALTER TABLE tasks ADD COLUMN description TEXT`);
    } catch (e) {
      // Sütun zaten varsa hata verir, bunu yok sayabiliriz
    }

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

// Kullanıcı Kendi Profil Bilgilerini Güncelleme
app.put('/api/users/profile', async (req, res) => {
  try {
    const { userId, name, email, password } = req.body;

    if (!userId || !name || !email) {
      return res.status(400).json({ error: 'Zorunlu alanlar eksik!' });
    }

    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?`,
        args: [name, email, hashedPassword, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ? WHERE id = ?`,
        args: [name, email, userId]
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

// Görev Oluşturma ve Stajyere E-Posta Bildirimi Endpoint'i
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assignedTo, category, endDate, workDays, createdBy } = req.body;

    // 1. Görevi veritabanına ekle
    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, description || '', assignedTo, category, endDate, workDays, createdBy]
    });

    // 2. Atanan stajyerin e-posta ve ad bilgilerini sorgula
    const userResult = await db.execute({
      sql: `SELECT name, email FROM users WHERE id = ?`,
      args: [assignedTo]
    });

    const intern = userResult.rows[0];

    // 3. Stajyer bulunduysa şık HTML mailini gönder
    if (intern && intern.email) {
      try {
        const companyLogoUrl = "data:image/png;base64,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"; // Şirket logonuzun web linki
        const appDashboardUrl = "https://intern-tasks-pannel.onrender.com/"; // Panele giriş linkiniz

        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { 
              name: "Görev & Takip Sistemi", 
              email: "semresahann@gmail.com" 
            },
            to: [{ email: intern.email, name: intern.name }],
            subject: `Yeni Görev Atandı: ${title}`,
            // HAZIRLADIĞIMIZ TASARIM BURAYA GELECEK:
            htmlContent: `
              <!DOCTYPE html>
              <html lang="tr">
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Yeni Görev Atandı</title>
              </head>
              <body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; -webkit-font-smoothing: antialiased;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f6f9; padding: 40px 10px;">
                  <tr>
                    <td align="center">
                      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);">
                        
                        <!-- ÜST HEADER / LOGO ALANI -->
                        <tr>
                          <td align="center" style="background-color: #1e293b; padding: 30px 20px; border-bottom: 4px solid #dc2626;">
                            <img src="${companyLogoUrl}" alt="Logo" style="max-height: 48px; width: auto; display: block; margin-bottom: 12px;" />
                            <h1 style="color: #ffffff; font-size: 20px; font-weight: 600; margin: 0; letter-spacing: 0.5px;">GÖREV & TAKİP PANELI</h1>
                          </td>
                        </tr>

                        <!-- BİLGİLENDİRME BAŞLIĞI -->
                        <tr>
                          <td style="padding: 30px 30px 15px 30px;">
                            <h2 style="color: #0f172a; font-size: 20px; font-weight: 700; margin: 0 0 8px 0;">Merhaba ${intern.name},</h2>
                            <p style="color: #475569; font-size: 15px; margin: 0; line-height: 1.5;">
                              <strong style="color: #0f172a;">${createdBy}</strong> tarafından hesabınıza yeni bir görev tanımlandı.
                            </p>
                          </td>
                        </tr>

                        <!-- GÖREV DETAY KARTLARI -->
                        <tr>
                          <td style="padding: 0 30px 20px 30px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px;">
                              
                              <tr>
                                <td style="padding-bottom: 12px;">
                                  <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Görev Başlığı</span>
                                  <div style="font-size: 16px; font-weight: 700; color: #1e293b; margin-top: 2px;">${title}</div>
                                </td>
                              </tr>

                              <tr>
                                <td style="padding-bottom: 12px;">
                                  <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Kategori</span>
                                  <div style="margin-top: 4px;">
                                    <span style="display: inline-block; background-color: #fee2e2; color: #dc2626; font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 6px;">
                                      ${category}
                                    </span>
                                  </div>
                                </td>
                              </tr>

                              <tr>
                                <td style="padding-bottom: 12px;">
                                  <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Açıklama</span>
                                  <div style="font-size: 14px; color: #334155; margin-top: 2px; line-height: 1.5;">
                                    ${description || 'Açıklama belirtilmedi.'}
                                  </div>
                                </td>
                              </tr>

                              <tr>
                                <td>
                                  <span style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Son Teslim Tarihi</span>
                                  <div style="font-size: 14px; font-weight: 600; color: #0f172a; margin-top: 2px;">
                                    📅 ${endDate} <span style="font-size: 12px; font-weight: normal; color: #64748b;">(${workDays} iş günü)</span>
                                  </div>
                                </td>
                              </tr>

                            </table>
                          </td>
                        </tr>

                        <!-- EYLEM BUTONU (CTA) -->
                        <tr>
                          <td align="center" style="padding: 0 30px 30px 30px;">
                            <a href="${appDashboardUrl}" target="_blank" style="display: inline-block; background-color: #dc2626; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 6px rgba(220, 38, 38, 0.25);">
                              Görev Detayına Git & Panele Giriş Yap
                            </a>
                          </td>
                        </tr>

                        <!-- FOOTER -->
                        <tr>
                          <td style="background-color: #f8fafc; padding: 20px 30px; border-top: 1px solid #e2e8f0; text-align: center;">
                            <p style="color: #94a3b8; font-size: 12px; margin: 0; line-height: 1.4;">
                              Bu e-posta Görev & Takip Sistemi tarafından otomatik olarak gönderilmiştir.<br>
                              Lütfen bu e-postaya doğrudan yanıt vermeyiniz.
                            </p>
                          </td>
                        </tr>

                      </table>
                    </td>
                  </tr>
                </table>
              </body>
              </html>
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

// Görevi Tamamlama Endpoint'i
app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await db.execute({
      sql: `UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`,
      args: [taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    res.json({ message: 'Görev başarıyla tamamlandı olarak işaretlendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + error.message });
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

    // Sadece LEADER ve ENGINEER yetkisine sahip kullanıcılar düzenleyebilir
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

// Doğrulama Kodu Gönderme Endpoint'i (Brevo Doğrudan REST API Entegrasyonu)
app.post('/api/send-verification-code', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'E-posta adresi gereklidir.' });
  }

  try {
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Node.js 18+ dahili fetch API kullanımı
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { 
          name: "Ekip Portali", 
          email: "semresahann@gmail.com" 
        },
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