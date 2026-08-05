// ============================================================================
// integrations.js
// Redmine (çift yönlü) + Google Calendar (kullanıcı bazlı OAuth) entegrasyonu
// ----------------------------------------------------------------------------
// Kullanım (server.js içinde):
//   const { setupIntegrations } = require('./integrations');
//   setupIntegrations(app, db);            // tabloları kurar, route'ları ekler
//   const integ = require('./integrations');
//   ... görev oluşturunca:  await integ.onTaskCreated(db, task);
//   ... toplantı oluşturunca: await integ.onMeetingCreated(db, meeting);
// ============================================================================

const { google } = require('googleapis');

// ----------------------------------------------------------------------------
// ORTAM DEĞİŞKENLERİ (Render > Environment sekmesine eklenecek)
// ----------------------------------------------------------------------------
const {
  // --- Google OAuth ---
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,       // örn: https://intern-tasks-pannel.onrender.com/api/google/callback

  // --- Redmine ---
  REDMINE_URL,               // örn: https://redmine.sirketiniz.com  (sonda / olmadan)
  REDMINE_API_KEY,           // Redmine > Hesabım > API erişim anahtarı
  REDMINE_PROJECT_ID,        // issue'ların açılacağı proje identifier'ı (örn: "genel")
  REDMINE_WEBHOOK_SECRET,    // webhook güvenliği için serbest bir parola
  CRON_SECRET,               // polling endpoint'ini korumak için serbest parola
} = process.env;

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// ============================================================================
// 1) VERİTABANI TABLOLARI
// ============================================================================
async function initIntegrationTables(db) {
  // Kullanıcı bazlı Google refresh token saklama
  await db.execute(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      user_id       INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      google_email  TEXT,
      updated_at    TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Site kaydı <-> Redmine issue eşlemesi
  // entity_type: 'task' | 'meeting'
  await db.execute(`
    CREATE TABLE IF NOT EXISTS redmine_sync (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type    TEXT NOT NULL,
      local_id       INTEGER NOT NULL,
      redmine_issue_id INTEGER,
      last_synced_at TEXT,
      UNIQUE(entity_type, local_id)
    )
  `);

  // Google Calendar event eşlemesi (silme/güncelleme için)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type   TEXT NOT NULL,
      local_id      INTEGER NOT NULL,
      user_id       INTEGER NOT NULL,
      gcal_event_id TEXT,
      created_at    TEXT,
      UNIQUE(entity_type, local_id, user_id)
    )
  `);

  // Polling durumu (en son çekilen updated_on)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS redmine_poll_state (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      last_updated_on TEXT
    )
  `);

  console.log('✅ Entegrasyon tabloları hazır.');
}

// ============================================================================
// 2) GOOGLE OAUTH YARDIMCILARI
// ============================================================================
function makeOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// Kullanıcı için yetkili bir calendar client döndürür (refresh token'dan)
async function getCalendarForUser(db, userId) {
  const row = await db.execute({
    sql: `SELECT refresh_token FROM oauth_tokens WHERE user_id = ?`,
    args: [userId],
  });
  if (row.rows.length === 0) return null; // kullanıcı henüz izin vermemiş

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({ refresh_token: row.rows[0].refresh_token });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

// Bir kullanıcının takvimine etkinlik ekler; gcal event id döner (yoksa null)
async function createCalendarEvent(db, userId, { summary, description, startISO, endISO, attendees }) {
  try {
    const calendar = await getCalendarForUser(db, userId);
    if (!calendar) {
      console.log(`ℹ️ user ${userId} Google izni vermemiş, takvim atlandı.`);
      return null;
    }

    const event = {
      summary,
      description: description || '',
      start: { dateTime: startISO, timeZone: 'Europe/Istanbul' },
      end:   { dateTime: endISO,   timeZone: 'Europe/Istanbul' },
      reminders: { useDefault: true },
    };
    if (attendees && attendees.length) {
      event.attendees = attendees.map(email => ({ email }));
    }

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });
    return res.data.id;
  } catch (err) {
    console.error('Takvim etkinliği oluşturulamadı:', err.message);
    return null;
  }
}

// ============================================================================
// 3) REDMINE YARDIMCILARI
// ============================================================================
async function redmineFetch(pathname, options = {}) {
  const url = `${REDMINE_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Redmine-API-Key': REDMINE_API_KEY,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    throw new Error(`Redmine ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// Redmine'da issue oluşturur, issue id döner
async function createRedmineIssue({ subject, description, dueDate }) {
  if (!REDMINE_URL || !REDMINE_API_KEY) {
    console.log('ℹ️ Redmine yapılandırılmamış, issue oluşturma atlandı.');
    return null;
  }
  const body = {
    issue: {
      project_id: REDMINE_PROJECT_ID,
      subject,
      description: description || '',
      ...(dueDate ? { due_date: dueDate } : {}),
    },
  };
  const data = await redmineFetch('/issues.json', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data?.issue?.id || null;
}

// Site kaydını Redmine ile eşleştirip kaydeder
async function linkRedmine(db, entityType, localId, redmineIssueId) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO redmine_sync (entity_type, local_id, redmine_issue_id, last_synced_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(entity_type, local_id)
          DO UPDATE SET redmine_issue_id = excluded.redmine_issue_id, last_synced_at = excluded.last_synced_at`,
    args: [entityType, localId, redmineIssueId, now],
  });
}

// ============================================================================
// 4) OLAY KANCALARI (server.js'ten çağrılır)
// ============================================================================

// Görev oluşturulunca: Redmine issue aç + atanan kişinin takvimine ekle
async function onTaskCreated(db, task) {
  // task: { id, title, description, assignedTo, assigneeEmail, endDate }
  try {
    const issueId = await createRedmineIssue({
      subject: `[Görev] ${task.title}`,
      description: task.description,
      dueDate: task.endDate, // 'YYYY-MM-DD' bekler
    });
    if (issueId) await linkRedmine(db, 'task', task.id, issueId);
  } catch (e) {
    console.error('Görev -> Redmine hatası:', e.message);
  }

  // Takvim: bitiş gününe tüm gün / 1 saatlik etkinlik
  try {
    if (task.endDate && task.assignedTo) {
      const start = `${task.endDate}T09:00:00`;
      const end   = `${task.endDate}T10:00:00`;
      const gcalId = await createCalendarEvent(db, task.assignedTo, {
        summary: `Görev teslimi: ${task.title}`,
        description: task.description || '',
        startISO: start,
        endISO: end,
      });
      if (gcalId) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO calendar_events (entity_type, local_id, user_id, gcal_event_id, created_at)
                VALUES ('task', ?, ?, ?, ?)`,
          args: [task.id, task.assignedTo, gcalId, new Date().toISOString()],
        });
      }
    }
  } catch (e) {
    console.error('Görev -> Takvim hatası:', e.message);
  }
}

// Toplantı oluşturulunca: Redmine issue aç + katılımcıların takvimine ekle
async function onMeetingCreated(db, meeting) {
  // meeting: { id, subject, description, preferredDate, requestedBy, attendeeUserIds[] }
  try {
    const issueId = await createRedmineIssue({
      subject: `[Toplantı] ${meeting.subject}`,
      description: meeting.description,
      dueDate: meeting.preferredDate ? meeting.preferredDate.substring(0, 10) : null,
    });
    if (issueId) await linkRedmine(db, 'meeting', meeting.id, issueId);
  } catch (e) {
    console.error('Toplantı -> Redmine hatası:', e.message);
  }

  try {
    if (meeting.preferredDate) {
      // preferredDate 'YYYY-MM-DD' veya 'YYYY-MM-DDTHH:mm' olabilir
      const base = meeting.preferredDate.length <= 10
        ? `${meeting.preferredDate}T14:00:00`
        : meeting.preferredDate;
      const startISO = base;
      const endISO = new Date(new Date(base).getTime() + 60 * 60 * 1000)
        .toISOString().substring(0, 19);

      const userIds = meeting.attendeeUserIds && meeting.attendeeUserIds.length
        ? meeting.attendeeUserIds
        : [meeting.requestedBy];

      for (const uid of userIds) {
        const gcalId = await createCalendarEvent(db, uid, {
          summary: `Toplantı: ${meeting.subject}`,
          description: meeting.description || '',
          startISO,
          endISO,
        });
        if (gcalId) {
          await db.execute({
            sql: `INSERT OR REPLACE INTO calendar_events (entity_type, local_id, user_id, gcal_event_id, created_at)
                  VALUES ('meeting', ?, ?, ?, ?)`,
            args: [meeting.id, uid, gcalId, new Date().toISOString()],
          });
        }
      }
    }
  } catch (e) {
    console.error('Toplantı -> Takvim hatası:', e.message);
  }
}

// ============================================================================
// 5) REDMINE -> SİTE (webhook + polling)
// ============================================================================

// Redmine'dan gelen bir issue'yu yerel görev tablosuna yansıtır.
// Sadece daha önce eşlenmiş issue'ları günceller (spam/yetkisiz kayıt açmamak için).
async function applyRedmineIssueToLocal(db, issue) {
  // issue: Redmine issue objesi
  const link = await db.execute({
    sql: `SELECT entity_type, local_id FROM redmine_sync WHERE redmine_issue_id = ?`,
    args: [issue.id],
  });
  if (link.rows.length === 0) {
    // Bu issue henüz siteyle eşlenmemiş -> Redmine'da elle açılmış demektir.
    // İstersen burada yeni bir yerel görev de oluşturabilirsin. Şimdilik logluyoruz.
    console.log(`ℹ️ Redmine #${issue.id} yerelde eşleşmiyor, atlandı.`);
    return;
  }

  const { entity_type, local_id } = link.rows[0];
  const statusName = (issue.status && issue.status.name) || '';
  // Redmine durumunu yerel duruma kabaca çevir
  const closed = /kapal|closed|resolved|çözül|tamam/i.test(statusName);

  if (entity_type === 'task') {
    await db.execute({
      sql: `UPDATE tasks SET title = ?, description = ?, status = ? WHERE id = ?`,
      args: [
        issue.subject.replace(/^\[Görev\]\s*/, ''),
        issue.description || '',
        closed ? 'COMPLETED' : 'IN_PROGRESS',
        local_id,
      ],
    });
  } else if (entity_type === 'meeting') {
    await db.execute({
      sql: `UPDATE meeting_requests SET subject = ?, description = ? WHERE id = ?`,
      args: [
        issue.subject.replace(/^\[Toplantı\]\s*/, ''),
        issue.description || '',
        local_id,
      ],
    });
  }

  await db.execute({
    sql: `UPDATE redmine_sync SET last_synced_at = ? WHERE redmine_issue_id = ?`,
    args: [new Date().toISOString(), issue.id],
  });
  console.log(`✅ Redmine #${issue.id} -> ${entity_type} #${local_id} güncellendi.`);
}

// Polling: son güncellemeden bu yana değişen issue'ları çeker
async function pollRedmine(db) {
  if (!REDMINE_URL || !REDMINE_API_KEY) return { skipped: true };

  const state = await db.execute(`SELECT last_updated_on FROM redmine_poll_state WHERE id = 1`);
  const since = state.rows.length ? state.rows[0].last_updated_on : null;

  // updated_on filtresi: since varsa ondan sonrasını iste
  let path = `/issues.json?project_id=${encodeURIComponent(REDMINE_PROJECT_ID)}&sort=updated_on:desc&limit=50`;
  if (since) path += `&updated_on=%3E%3D${encodeURIComponent(since)}`; // >= since

  const data = await redmineFetch(path, { method: 'GET' });
  const issues = (data && data.issues) || [];

  let applied = 0;
  for (const issue of issues) {
    await applyRedmineIssueToLocal(db, issue);
    applied++;
  }

  // En yeni updated_on'u kaydet
  const newest = issues.length ? issues[0].updated_on : since;
  if (newest) {
    await db.execute({
      sql: `INSERT INTO redmine_poll_state (id, last_updated_on) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET last_updated_on = excluded.last_updated_on`,
      args: [newest],
    });
  }

  return { applied, checked: issues.length };
}

// ============================================================================
// 6) ROUTE KURULUMU
// ============================================================================
function setupIntegrations(app, db) {
  initIntegrationTables(db).catch(e =>
    console.error('Entegrasyon tabloları kurulamadı:', e.message)
  );

  // --- Google OAuth başlat: kullanıcıyı Google izin ekranına yollar ---
  app.get('/api/google/auth', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).send('userId gerekli');

    const oauth2 = makeOAuthClient();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',       // refresh token almak için şart
      prompt: 'consent',            // her seferinde refresh token garantile
      scope: SCOPES,
      state: String(userId),        // callback'te kim olduğunu bilmek için
    });
    res.redirect(url);
  });

  // --- Google OAuth callback: refresh token'ı kaydeder ---
  app.get('/api/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const userId = state;
      if (!code || !userId) return res.status(400).send('Eksik parametre.');

      const oauth2 = makeOAuthClient();
      const { tokens } = await oauth2.getToken(code);

      // Kullanıcının Google e-postasını al (opsiyonel, bilgi amaçlı)
      let googleEmail = null;
      try {
        oauth2.setCredentials(tokens);
        const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
        const me = await oauth2Api.userinfo.get();
        googleEmail = me.data.email;
      } catch (_) {}

      if (!tokens.refresh_token) {
        // Kullanıcı daha önce izin verdiyse Google refresh token göndermez.
        // prompt:'consent' bunu çözer ama yine de kontrol edelim.
        return res.status(400).send(
          'Refresh token alınamadı. Google hesabı izinlerinden uygulamayı kaldırıp tekrar deneyin.'
        );
      }

      await db.execute({
        sql: `INSERT INTO oauth_tokens (user_id, refresh_token, google_email, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id)
              DO UPDATE SET refresh_token = excluded.refresh_token,
                            google_email = excluded.google_email,
                            updated_at = excluded.updated_at`,
        args: [userId, tokens.refresh_token, googleEmail, new Date().toISOString()],
      });

      res.send('<h3>✅ Google Takvim bağlantısı başarılı. Bu sekmeyi kapatabilirsiniz.</h3>');
    } catch (err) {
      console.error('OAuth callback hatası:', err);
      res.status(500).send('Bağlantı hatası: ' + err.message);
    }
  });

  // --- Kullanıcının takvim bağlantısı var mı? (arayüzde buton göstermek için) ---
  app.get('/api/google/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId gerekli' });
    const row = await db.execute({
      sql: `SELECT google_email FROM oauth_tokens WHERE user_id = ?`,
      args: [userId],
    });
    res.json({
      connected: row.rows.length > 0,
      email: row.rows.length ? row.rows[0].google_email : null,
    });
  });

  // --- Redmine WEBHOOK: plugin kuruluysa Redmine buraya POST atar ---
  app.post('/api/redmine/webhook', async (req, res) => {
    try {
      // Basit güvenlik: ?secret=... eşleşmezse reddet
      if (REDMINE_WEBHOOK_SECRET && req.query.secret !== REDMINE_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Yetkisiz.' });
      }
      // redmine_webhook plugin payload'u genelde { payload: { issue: {...} } } biçiminde
      const issue =
        (req.body && req.body.payload && req.body.payload.issue) ||
        (req.body && req.body.issue) ||
        null;

      if (!issue) return res.status(400).json({ error: 'issue bulunamadı.' });
      await applyRedmineIssueToLocal(db, issue);
      res.json({ ok: true });
    } catch (err) {
      console.error('Webhook hatası:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Redmine POLLING tetikleyici (harici cron / UptimeRobot çağırır) ---
  app.get('/api/cron/redmine-poll', async (req, res) => {
    try {
      if (CRON_SECRET && req.query.secret !== CRON_SECRET) {
        return res.status(403).json({ error: 'Yetkisiz.' });
      }
      const result = await pollRedmine(db);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Polling hatası:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('✅ Entegrasyon route\'ları yüklendi.');
}

module.exports = {
  setupIntegrations,
  onTaskCreated,
  onMeetingCreated,
  createCalendarEvent,
  createRedmineIssue,
  pollRedmine,
};