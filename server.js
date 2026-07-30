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
        assigned_to INTEGER NOT NULL,
        category TEXT NOT NULL,
        end_date TEXT NOT NULL,
        work_days INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT DEFAULT 'IN_PROGRESS',
        FOREIGN KEY(assigned_to) REFERENCES users(id)
      )
    `);

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

// Görev Oluşturma
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, assignedTo, category, endDate, workDays, createdBy } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO tasks (title, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, assignedTo, category, endDate, workDays, createdBy]
    });

    res.json({ id: Number(result.lastInsertRowid) });
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
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ? AND role = 'INTERN'`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Silinecek stajyer bulunamadı.' });
    res.json({ message: 'Stajyer ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Stajyer silinirken hata oluştu: ' + error.message });
  }
});

// Görev Güncelleme
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { title, assignedTo, category, endDate, workDays, userRole } = req.body;

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE tasks SET title = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ? WHERE id = ?`,
      args: [title, assignedTo, category, endDate, workDays, taskId]
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

    // İlişkili logları, görevleri ve kullanıcıyı sil
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Hesap ve ilişkili veriler başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Hesap silinirken hata oluştu: ' + error.message });
  }
});

// Doğrulama Kodu Gönderme (Geçici / Mock Endpoint)
app.post('/api/send-verification-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-posta adresi gereklidir.' });
    
    // Gerçek e-posta servisi kurulduğunda buraya Nodemailer / Resend entegre edilebilir.
    console.log(`Doğrulama kodu istenen e-posta: ${email}`);
    res.json({ message: 'Doğrulama kodu e-posta adresinize gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});