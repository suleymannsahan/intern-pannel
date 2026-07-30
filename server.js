import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';

const app = express();
app.use(cors());
app.use(express.json());

// Turso Veritabanı Bağlantısı
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Veritabanı Tablolarını Başlatma
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intern_id INTEGER NOT NULL,
      intern_name TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(intern_id) REFERENCES users(id)
    )
  `);

  // GÜNCELLENDİ: 'description' alanı tabloya eklendi
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

  console.log("Veritabanı tabloları hazır.");
}

initDb().catch(console.error);

// ------------------- KULLANICI ENDPOINT'LERİ -------------------

// Kayıt Olma
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    
    // E-posta benzersizlik kontrolü
    const checkEmail = await db.execute({
      sql: `SELECT id FROM users WHERE email = ?`,
      args: [email]
    });

    if (checkEmail.rows.length > 0) {
      return res.status(400).json({ error: 'Bu e-posta adresi zaten kullanımda!' });
    }

    const result = await db.execute({
      sql: `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      args: [name, email, password, role]
    });
    
    res.json({ id: Number(result.lastInsertRowid), name, email, role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Giriş Yapma
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.execute({
      sql: `SELECT * FROM users WHERE email = ? AND password = ?`,
      args: [email, password]
    });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı!' });
    }
    const user = result.rows[0];
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tüm Kullanıcıları Getirme
app.get('/api/users', async (req, res) => {
  try {
    const result = await db.execute('SELECT id, name, email, role FROM users');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Profil Güncelleme
app.put('/api/users/profile', async (req, res) => {
  try {
    const { userId, name, email, newPassword } = req.body;

    if (!userId) return res.status(400).json({ error: 'Kullanıcı ID eksik!' });

    // E-posta çakışması kontrolü
    const emailCheck = await db.execute({
      sql: `SELECT id FROM users WHERE email = ? AND id != ?`,
      args: [email, userId]
    });

    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Bu e-posta başka bir kullanıcı tarafından kullanılıyor!' });
    }

    if (newPassword && newPassword.trim() !== "") {
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?`,
        args: [name, email, newPassword, userId]
      });
    } else {
      await db.execute({
        sql: `UPDATE users SET name = ?, email = ? WHERE id = ?`,
        args: [name, email, userId]
      });
    }

    // Stajyer adını daily_logs tablosunda da güncelle
    await db.execute({
      sql: `UPDATE daily_logs SET intern_name = ? WHERE intern_id = ?`,
      args: [name, userId]
    });

    res.json({ message: 'Profil başarıyla güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: 'Profil güncellenirken hata oluştu: ' + error.message });
  }
});

// YENİ EKLENDİ: Kullanıcının Kendi Hesabını Silmesi
app.delete('/api/users/profile', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Kullanıcı ID eksik!' });
    }

    // Kullanıcıya ait ilişkili günlük kayıtları ve görevleri sil, ardından kullanıcıyı sil
    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    res.json({ message: 'Hesap ve ilişkili veriler başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Hesap silinirken hata oluştu: ' + error.message });
  }
});

// Yönetici Tarafından Kullanıcı Silme
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { userRole } = req.body;

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    await db.execute({ sql: `DELETE FROM daily_logs WHERE intern_id = ?`, args: [userId] });
    await db.execute({ sql: `DELETE FROM tasks WHERE assigned_to = ?`, args: [userId] });
    const result = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    res.json({ message: 'Kullanıcı ve ilişkili verileri başarıyla silindi.' });
  } catch (error) {
    res.status(500).json({ error: 'Kullanıcı silinemedi: ' + error.message });
  }
});

// YENİ EKLENDİ: Ekip Lideri Doğrulama Kodu Gönderme (Mock Endpoint)
app.post('/api/send-verification-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'E-posta adresi gereklidir.' });
    }
    
    // Gerçek e-posta entegrasyonu (Nodemailer vb.) yapılana kadar konsola çıktı basılır.
    console.log(`[DOĞRULAMA KODU İSTEĞİ] Gönderilen E-Posta: ${email}`);
    
    res.json({ message: 'Doğrulama kodu e-posta adresinize gönderildi.' });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
  }
});

// ------------------- GÜNLÜK (DAILY LOG) ENDPOINT'LERİ -------------------

// Günlük Kayıtları Getirme
app.get('/api/logs', async (req, res) => {
  try {
    const { internId } = req.query;
    let sql = 'SELECT * FROM daily_logs ORDER BY date DESC';
    let args = [];
    
    if (internId) {
      sql = 'SELECT * FROM daily_logs WHERE intern_id = ? ORDER BY date DESC';
      args = [internId];
    }
    
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Yeni Günlük Ekleme
app.post('/api/logs', async (req, res) => {
  try {
    const { internId, internName, date, hours, content } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO daily_logs (intern_id, intern_name, date, hours, content, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      args: [internId, internName, date, hours, content]
    });
    res.json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Durumu Güncelleme (Onayla / Reddet)
app.put('/api/logs/:id/status', async (req, res) => {
  try {
    const { status, userRole } = req.body;
    const logId = req.params.id;

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({
      sql: `UPDATE daily_logs SET status = ? WHERE id = ?`,
      args: [status, logId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Log bulunamadı.' });

    res.json({ message: 'Durum güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Günlük Silme
app.delete('/api/logs/:id', async (req, res) => {
  try {
    const logId = req.params.id;
    const { userId, userRole } = req.body;

    const checkLog = await db.execute({ sql: `SELECT intern_id FROM daily_logs WHERE id = ?`, args: [logId] });
    if (checkLog.rows.length === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER' && checkLog.rows[0].intern_id !== userId) {
      return res.status(403).json({ error: 'Bu kaydı silme yetkiniz yok!' });
    }

    await db.execute({ sql: `DELETE FROM daily_logs WHERE id = ?`, args: [logId] });
    res.json({ message: 'Kayıt silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ------------------- GÖREV (TASK) ENDPOINT'LERİ -------------------

// Görevleri Getirme
app.get('/api/tasks', async (req, res) => {
  try {
    const { assignedTo } = req.query;
    let sql = 'SELECT * FROM tasks ORDER BY id DESC';
    let args = [];

    if (assignedTo) {
      sql = 'SELECT * FROM tasks WHERE assigned_to = ? ORDER BY id DESC';
      args = [assignedTo];
    }

    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GÜNCELLENDİ: Görev Oluşturma ('description' alanı eklendi)
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assignedTo, category, endDate, workDays, createdBy } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO tasks (title, description, assigned_to, category, end_date, work_days, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
      args: [title, description || '', assignedTo, category, endDate, workDays, createdBy]
    });

    res.json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GÜNCELLENDİ: Görev Güncelleme ('description' alanı eklendi)
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

// Görev Durumu Güncelleme (Tamamlandı/Devam Ediyor)
app.put('/api/tasks/:id/status', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { status } = req.body;

    const result = await db.execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: [status, taskId]
    });

    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: 'Görev durumu güncellendi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev Silme
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { userRole } = req.body;

    if (userRole !== 'LEADER' && userRole !== 'ENGINEER') {
      return res.status(403).json({ error: 'Bu işlemi yapmaya yetkiniz yok!' });
    }

    const result = await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [taskId] });
    if (result.rowsAffected === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

    res.json({ message: 'Görev silindi.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sunucuyu Başlatma
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda dinleniyor...`);
});