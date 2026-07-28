const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Veritabanı Bağlantısı
const db = new sqlite3.Database('./intern-tasks-site.db', (err) => {
  if (err) console.error('Veritabanı hatası:', err.message);
  else console.log('SQLite veritabanına bağlandı.');
});

// Veritabanı Tablolarını Oluşturma
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    intern_start_date TEXT,
    intern_end_date TEXT
  )`);

  db.run(`ALTER TABLE users ADD COLUMN intern_start_date TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN intern_end_date TEXT`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    assigned_to INTEGER NOT NULL,
    category TEXT NOT NULL,
    end_date TEXT NOT NULL,
    work_days INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT DEFAULT 'IN_PROGRESS',
    FOREIGN KEY(assigned_to) REFERENCES users(id)
  )`);

  db.run(`ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'IN_PROGRESS'`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    intern_id INTEGER NOT NULL,
    log_date TEXT NOT NULL,
    note TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(intern_id) REFERENCES users(id)
  )`);
});

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

    const query = `INSERT INTO users (name, email, password, role, intern_start_date, intern_end_date) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [name, email, hashedPassword, role, role === 'INTERN' ? startDate : null, role === 'INTERN' ? endDate : null], function (err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Bu e-posta zaten kayıtlı!' });
        }
        return res.status(500).json({ error: 'Veritabanı hatası: ' + err.message });
      }
      res.json({ message: 'Kullanıcı başarıyla oluşturuldu.', userId: this.lastID });
    });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// Giriş Yap
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Kullanıcı bulunamadı.' });
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Hatalı şifre!' });

    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  });
});

// Şifre Sıfırlama
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  db.run(`UPDATE users SET password = ? WHERE email = ?`, [hashedPassword, email], function (err) {
    if (err || this.changes === 0) return res.status(400).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ message: 'Şifre güncellendi.' });
  });
});

// Kullanıcı Listesi
app.get('/api/users', (req, res) => {
  db.all(`SELECT id, name, email, role, intern_start_date, intern_end_date FROM users`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Staj Tarihlerini Güncelleme
app.put('/api/users/:id/intern-dates', (req, res) => {
  const userId = req.params.id;
  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Başlangıç ve bitiş tarihleri gereklidir.' });
  }

  const query = `UPDATE users SET intern_start_date = ?, intern_end_date = ? WHERE id = ?`;
  db.run(query, [startDate, endDate, userId], function (err) {
    if (err) return res.status(500).json({ error: 'Tarihler kaydedilemedi: ' + err.message });
    res.json({ message: 'Staj tarihleri başarıyla güncellendi.' });
  });
});

// Görev Oluşturma
app.post('/api/tasks', (req, res) => {
  const { title, assignedTo, category, endDate, workDays, createdBy } = req.body;
  const query = `INSERT INTO tasks (title, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`;
  db.run(query, [title, assignedTo, category, endDate, workDays, createdBy], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

// Görevleri Getirme
app.get('/api/tasks', (req, res) => {
  const { userId, role } = req.query;
  let query = `SELECT tasks.*, users.name as assignee_name FROM tasks JOIN users ON tasks.assigned_to = users.id`;
  let params = [];

  if (role === 'INTERN') {
    query += ` WHERE tasks.assigned_to = ?`;
    params.push(userId);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Görevi Tamamlama (Erkenden Bitirme) Endpoint'i
app.put('/api/tasks/:id/complete', (req, res) => {
  const taskId = req.params.id;
  db.run(`UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`, [taskId], function (err) {
    if (err) return res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    res.json({ message: 'Görev başarıyla tamamlandı olarak işaretlendi.' });
  });
});

// Günlük Not Ekleme
app.post('/api/daily-logs', (req, res) => {
  const { taskId, internId, logDate, note } = req.body;
  const query = `INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`;
  db.run(query, [taskId, internId, logDate, note], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

// Günlük Notları Getirme
app.get('/api/daily-logs', (req, res) => {
  db.all(`SELECT * FROM daily_logs`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Görev Silme
app.delete('/api/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  const userRole = req.headers['user-role'];

  if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
    return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
  }

  db.run(`DELETE FROM daily_logs WHERE task_id = ?`, [taskId], (err) => {
    if (err) return res.status(500).json({ error: 'İlişkili loglar silinirken hata oluştu: ' + err.message });

    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId], function (err) {
      if (err) return res.status(500).json({ error: 'Görev silinemedi: ' + err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

      res.json({ message: 'Görev başarıyla silindi.' });
    });
  });
});

// Stajyer Silme
app.delete('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  const userRole = (req.headers['user-role'] || '').toUpperCase();

  if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
    return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
  }

  db.run(`DELETE FROM daily_logs WHERE intern_id = ?`, [userId], (err) => {
    if (err) return res.status(500).json({ error: 'Loglar silinirken hata oluştu: ' + err.message });

    db.run(`DELETE FROM tasks WHERE assigned_to = ?`, [userId], (err) => {
      if (err) return res.status(500).json({ error: 'Atanan görevler silinirken hata oluştu: ' + err.message });

      db.run(`DELETE FROM users WHERE id = ? AND role = 'INTERN'`, [userId], function (err) {
        if (err) return res.status(500).json({ error: 'Stajyer silinemedi: ' + err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Silinecek stajyer bulunamadı.' });

        res.json({ message: 'Stajyer ve ilişkili tüm verileri başarıyla silindi.' });
      });
    });
  });
});

// Görev Güncelleme
app.put('/api/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  const { title, assignedTo, category, endDate, workDays, userRole } = req.body;

  if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
    return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
  }

  const query = `
    UPDATE tasks 
    SET title = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ? 
    WHERE id = ?
  `;

  db.run(query, [title, assignedTo, category, endDate, workDays, taskId], function (err) {
    if (err) return res.status(500).json({ error: 'Görev güncellenemedi: ' + err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: 'Görev başarıyla güncellendi.' });
  });
});

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! http://localhost:${PORT}`);
});