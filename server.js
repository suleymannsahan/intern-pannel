const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
// Render veya bulut sunucuların atadığı portu kullanır, yoksa 5000 varsayılandır.
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Veritabanı Bağlantısı (better-sqlite3 senkron çalışır)
let db;
try {
  db = new Database('./intern-tasks-site.db');
  console.log('SQLite veritabanına bağlandı.');
  // WAL modunu aktif ederek okuma/yazma performansını ve kararlılığını artırıyoruz
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error('Veritabanı hatası:', err.message);
}

// Veritabanı Tablolarını Oluşturma
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    intern_start_date TEXT,
    intern_end_date TEXT
  );

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
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    intern_id INTEGER NOT NULL,
    log_date TEXT NOT NULL,
    note TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(intern_id) REFERENCES users(id)
  );
`);

// Sütunların önceden var olup olmadığını güvenli şekilde kontrol edip ekleme
const addColumnIfNotExists = (table, column, type) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some(col => col.name === column);
  if (!exists) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
};

addColumnIfNotExists('users', 'intern_start_date', 'TEXT');
addColumnIfNotExists('users', 'intern_end_date', 'TEXT');
addColumnIfNotExists('tasks', 'status', "TEXT DEFAULT 'IN_PROGRESS'");

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

    const stmt = db.prepare(`INSERT INTO users (name, email, password, role, intern_start_date, intern_end_date) VALUES (?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
      name,
      email,
      hashedPassword,
      role,
      role === 'INTERN' ? startDate : null,
      role === 'INTERN' ? endDate : null
    );

    res.json({ message: 'Kullanıcı başarıyla oluşturuldu.', userId: info.lastInsertRowid });
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
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);

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

    const info = db.prepare(`UPDATE users SET password = ? WHERE email = ?`).run(hashedPassword, email);
    if (info.changes === 0) return res.status(400).json({ error: 'Kullanıcı bulunamadı.' });

    res.json({ message: 'Şifre güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// Kullanıcı Listesi
app.get('/api/users', (req, res) => {
  try {
    const users = db.prepare(`SELECT id, name, email, role, intern_start_date, intern_end_date FROM users`).all();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Staj Tarihlerini Güncelleme
app.put('/api/users/:id/intern-dates', (req, res) => {
  try {
    const userId = req.params.id;
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Başlangıç ve bitiş tarihleri gereklidir.' });
    }

    db.prepare(`UPDATE users SET intern_start_date = ?, intern_end_date = ? WHERE id = ?`).run(startDate, endDate, userId);
    res.json({ message: 'Staj tarihleri başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Tarihler kaydedilemedi: ' + error.message });
  }
});

// Görev Oluşturma
app.post('/api/tasks', (req, res) => {
  try {
    const { title, assignedTo, category, endDate, workDays, createdBy } = req.body;
    const stmt = db.prepare(`INSERT INTO tasks (title, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`);
    const info = stmt.run(title, assignedTo, category, endDate, workDays, createdBy);

    res.json({ id: info.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görevleri Getirme
app.get('/api/tasks', (req, res) => {
  try {
    const { userId, role } = req.query;
    let query = `SELECT tasks.*, users.name as assignee_name FROM tasks JOIN users ON tasks.assigned_to = users.id`;
    let params = [];

    if (role === 'INTERN') {
      query += ` WHERE tasks.assigned_to = ?`;
      params.push(userId);
    }

    const tasks = db.prepare(query).all(...params);
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görevi Tamamlama Endpoint'i
app.put('/api/tasks/:id/complete', (req, res) => {
  try {
    const taskId = req.params.id;
    const info = db.prepare(`UPDATE tasks SET status = 'COMPLETED' WHERE id = ?`).run(taskId);

    if (info.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
    res.json({ message: 'Görev başarıyla tamamlandı olarak işaretlendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev durumu güncellenemedi: ' + error.message });
  }
});

// Günlük Not Ekleme
app.post('/api/daily-logs', (req, res) => {
  try {
    const { taskId, internId, logDate, note } = req.body;
    const stmt = db.prepare(`INSERT INTO daily_logs (task_id, intern_id, log_date, note) VALUES (?, ?, ?, ?)`);
    const info = stmt.run(taskId, internId, logDate, note);

    res.json({ id: info.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Notları Getirme
app.get('/api/daily-logs', (req, res) => {
  try {
    const logs = db.prepare(`SELECT * FROM daily_logs`).all();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Silme
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const userRole = req.headers['user-role'];

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Transaction kullanarak atomik silme yapıyoruz
    const deleteTask = db.transaction((id) => {
      db.prepare(`DELETE FROM daily_logs WHERE task_id = ?`).run(id);
      return db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    });

    const info = deleteTask(taskId);
    if (info.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: 'Görev başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev silinirken hata oluştu: ' + error.message });
  }
});

// Stajyer Silme
app.delete('/api/users/:id', (req, res) => {
  try {
    const userId = req.params.id;
    const userRole = (req.headers['user-role'] || '').toUpperCase();

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    // Transaction kullanarak stajyer ve ilişkili tüm verileri silme
    const deleteIntern = db.transaction((id) => {
      db.prepare(`DELETE FROM daily_logs WHERE intern_id = ?`).run(id);
      db.prepare(`DELETE FROM tasks WHERE assigned_to = ?`).run(id);
      return db.prepare(`DELETE FROM users WHERE id = ? AND role = 'INTERN'`).run(id);
    });

    const info = deleteIntern(userId);
    if (info.changes === 0) return res.status(404).json({ error: 'Silinecek stajyer bulunamadı.' });

    res.json({ message: 'Stajyer ve ilişkili tüm verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Stajyer silinirken hata oluştu: ' + error.message });
  }
});

// Görev Güncelleme
app.put('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const { title, assignedTo, category, endDate, workDays, userRole } = req.body;

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const stmt = db.prepare(`
      UPDATE tasks 
      SET title = ?, assigned_to = ?, category = ?, end_date = ?, work_days = ? 
      WHERE id = ?
    `);

    const info = stmt.run(title, assignedTo, category, endDate, workDays, taskId);
    if (info.changes === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: 'Görev başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Görev güncellenemedi: ' + error.message });
  }
});

// Sunucuyu Çalıştır
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu aktif! Port: ${PORT}`);
});