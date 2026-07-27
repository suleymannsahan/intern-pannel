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
    role TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    assigned_to INTEGER NOT NULL,
    category TEXT NOT NULL,
    end_date TEXT NOT NULL,
    work_days INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    FOREIGN KEY(assigned_to) REFERENCES users(id)
  )`);

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
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Lütfen tüm alanları doldurun!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`;
    db.run(query, [name, email, hashedPassword, role], function (err) {
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
  db.all(`SELECT id, name, email, role FROM users`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Görev Oluşturma
app.post('/api/tasks', (req, res) => {
  const { title, assignedTo, category, endDate, workDays, createdBy } = req.body;
  const query = `INSERT INTO tasks (title, assigned_to, category, end_date, work_days, created_by) VALUES (?, ?, ?, ?, ?, ?)`;
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

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! http://localhost:${PORT}`);
});