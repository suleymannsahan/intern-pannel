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
        revised_by TEXT,
        revised_at TEXT,
        FOREIGN KEY(assigned_to) REFERENCES users(id)
      )
    `);

    try { await db.execute(`ALTER TABLE tasks ADD COLUMN description TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN review_comment TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN revised_by TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE tasks ADD COLUMN revised_at TEXT`); } catch (e) {}

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

// Görev Listesi
app.get('/api/tasks', async (req, res) => {
  try {
    const { userId, role } = req.query;
    let query = `
      SELECT t.*, u.name as assignee_name 
      FROM tasks t 
      LEFT JOIN users u ON t.assigned_to = u.id
    `;
    let args = [];

    if (role === 'INTERN') {
      query += ` WHERE t.assigned_to = ?`;
      args.push(userId);
    }

    query += ` ORDER BY t.id DESC`;

    const result = await db.execute({ sql: query, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    res.json({ message: 'Görev başarıyla eklendi.', taskId: Number(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Bilgilerini ve Stajyerini / Tarihini Güncelleme (Ekip Lideri ve Mühendis İçin)
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { title, assignedTo, description, category, endDate, userRole } = req.body;

    if (userRole !== 'ENGINEER' && userRole !== 'LEADER') {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz bulunmamaktadır.' });
    }

    await db.execute({
      sql: `UPDATE tasks SET title = ?, assigned_to = ?, description = ?, category = ?, end_date = ? WHERE id = ?`,
      args: [title, assignedTo, description || '', category, endDate, taskId]
    });

    res.json({ message: 'Görev başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev güncellenemedi: ' + error.message });
  }
});

// Görevi İnceleme / Revize Etme (Yazan Kişi ve Tarih Kaydıyla)
app.put('/api/tasks/:id/review', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { action, comment, userRole, revisedBy } = req.body;

    if (userRole !== 'ENGINEER' && userRole !== 'LEADER') {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];

    if (action === 'APPROVE') {
      await db.execute({
        sql: `UPDATE tasks SET status = 'APPROVED' WHERE id = ?`,
        args: [taskId]
      });
      return res.json({ message: 'Görev onaylandı.' });
    } else if (action === 'REVISION_REQUESTED') {
      await db.execute({
        sql: `UPDATE tasks SET status = 'REVISION_REQUESTED', review_comment = ?, revised_by = ?, revised_at = ? WHERE id = ?`,
        args: [comment, revisedBy || 'Yetkili', todayStr, taskId]
      });

      await db.execute({
        sql: `INSERT INTO task_revisions (task_id, revised_by, comment, created_at) VALUES (?, ?, ?, ?)`,
        args: [taskId, revisedBy || 'Yetkili', comment, todayStr]
      });

      return res.json({ message: 'Revize isteği başarıyla iletildi.' });
    } else {
      return res.status(400).json({ error: 'Geçersiz işlem.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görevi Tamamlama (Stajyer için)
app.put('/api/tasks/:id/complete', async (req, res) => {
  try {
    const taskId = req.params.id;
    await db.execute({
      sql: `UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`,
      args: [taskId]
    });
    res.json({ message: 'Görev tamamlandı olarak işaretlendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Silme
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [taskId] });
    await db.execute({ sql: `DELETE FROM daily_logs WHERE task_id = ?`, args: [taskId] });
    res.json({ message: 'Görev silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Log Ekleme
app.post('/api/daily-logs', async (req, res) => {
  try {
    const { taskId, internId, note, logDate } = req.body;
    await db.execute({
      sql: `INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`,
      args: [taskId, internId, logDate, note]
    });
    res.json({ message: 'Günlük not eklendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Log Listesi
app.get('/api/daily-logs', async (req, res) => {
  try {
    const result = await db.execute(`SELECT * FROM daily_logs ORDER BY id DESC`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});