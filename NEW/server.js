const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('tests.db', (err) => {
    if (err) console.error("DB Error:", err.message);
    else console.log("Connected to database.");
});

// Увеличаване на лимита за данни (за снимките)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// === НАСТРОЙКА НА БАЗАТА ДАННИ ===
db.serialize(() => {
  // 1. Таблица Потребители
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    full_name TEXT,
    student_class TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 2. Таблица Тестове (Добавена колона question_count)
  db.run(`CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER,
    title TEXT,
    questions TEXT,
    question_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 3. Таблица Отговори
  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER,
    student_id INTEGER,
    student_name TEXT,
    student_class TEXT,
    answers TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    auto_grade REAL,
    manual_grade REAL,
    manual_points TEXT,
    teacher_comment TEXT
  )`);

  // 4. МИГРАЦИЯ: Добавяне на липсващи колони (Safe Migration)
  const cols = [
      {table: 'submissions', col: 'student_id', type: 'INTEGER'},
      {table: 'tests', col: 'creator_id', type: 'INTEGER'},
      {table: 'tests', col: 'question_count', type: 'INTEGER DEFAULT 0'}, // FIX за грешката
      {table: 'submissions', col: 'manual_points', type: 'TEXT'},
      {table: 'submissions', col: 'manual_grade', type: 'REAL'},
      {table: 'submissions', col: 'teacher_comment', type: 'TEXT'}
  ];
  
  cols.forEach(c => {
      // Опит за добавяне на колона. Ако съществува, SQLite ще върне грешка, която игнорираме.
      db.run(`ALTER TABLE ${c.table} ADD COLUMN ${c.col} ${c.type}`, (err) => {});
  });
});

// === AUTH ROUTES ===

app.post('/api/register', (req, res) => {
    const { username, password, role, fullName, studentClass, secretCode } = req.body;
    if (role === 'teacher' && secretCode !== 'TEACHER123') return res.status(403).json({ error: 'Грешен код!' });
    if (role === 'admin' && secretCode !== 'ADMIN123') return res.status(403).json({ error: 'Грешен код!' });

    db.run(`INSERT INTO users (username, password, role, full_name, student_class) VALUES (?, ?, ?, ?, ?)`, 
        [username, password, role, fullName, studentClass], 
        function(err) {
            if (err) return res.status(400).json({ error: 'Потребителското име е заето.' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, role, full_name, student_class FROM users WHERE username = ? AND password = ?", 
        [username, password], (err, row) => {
            if (!row) return res.status(401).json({ error: 'Грешни данни' });
            res.json({ success: true, user: row });
        }
    );
});

// === ADMIN ROUTES ===

app.get('/api/users', (req, res) => {
    db.all("SELECT id, username, role, full_name, student_class FROM users ORDER BY id DESC", [], (err, rows) => res.json(rows));
});

app.put('/api/users/:id', (req, res) => {
    const { username, password, role, fullName, studentClass } = req.body;
    let sql = "UPDATE users SET username=?, role=?, full_name=?, student_class=? WHERE id=?";
    let params = [username, role, fullName, studentClass, req.params.id];
    if (password && password.trim() !== "") {
        sql = "UPDATE users SET username=?, password=?, role=?, full_name=?, student_class=? WHERE id=?";
        params = [username, password, role, fullName, studentClass, req.params.id];
    }
    db.run(sql, params, (err) => {
        if(err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.delete('/api/users/:id', (req, res) => {
    db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
        if(err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

// === TEST ROUTES ===

app.get('/api/tests', (req, res) => {
  // Използваме question_count колоната, или я изчисляваме динамично ако е стара база
  db.all("SELECT id, title, creator_id, question_count, questions FROM tests ORDER BY id DESC", [], (err, rows) => {
      if(err) return res.json([]);
      
      // Fallback: Ако question_count е 0 или null, преброяваме ръчно за визуализацията
      const results = rows.map(r => {
          let count = r.question_count;
          if(!count) {
              try { count = JSON.parse(r.questions).length; } catch(e) { count = 0; }
          }
          return { id: r.id, title: r.title, creator_id: r.creator_id, question_count: count };
      });
      res.json(results);
  });
});

app.get('/api/tests/:id', (req, res) => {
  db.get("SELECT * FROM tests WHERE id = ?", [req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Not found' });
    try { row.questions = JSON.parse(row.questions); } catch(e) { row.questions = []; }
    res.json(row);
  });
});

// СЪЗДАВАНЕ НА ТЕСТ (FIXED)
app.post('/api/tests', (req, res) => {
  const { title, questions, creatorId } = req.body;
  
  // FIX: Изчисляваме броя въпроси преди запис
  const count = questions ? questions.length : 0;

  db.run("INSERT INTO tests (title, questions, creator_id, question_count) VALUES (?, ?, ?, ?)", 
    [title, JSON.stringify(questions), creatorId, count], 
    function(err) {
      if (err) {
          console.error("SAVE ERROR:", err.message);
          return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
    }
  );
});

app.delete('/api/tests/:id', (req, res) => {
  db.run("DELETE FROM tests WHERE id = ?", [req.params.id], (err) => res.json({ deleted: true }));
});

// === SUBMISSION ROUTES ===

app.post('/api/grade/:id', (req, res) => {
  const { answers, studentId, studentName, studentClass } = req.body;
  const testId = req.params.id;
  
  db.get("SELECT questions FROM tests WHERE id = ?", [testId], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Not found' });
    let questions = JSON.parse(row.questions);
    let total = 0, earned = 0;

    questions.forEach((q, i) => {
      total += (q.points || 1);
      const ans = answers[`q${i}`];
      if (q.type === 'single' && parseInt(ans) === q.correct) earned += (q.points||1);
      else if (q.type === 'multiple') {
          const cSet = new Set((q.correct||[]).map(String));
          const sSet = new Set((Array.isArray(ans)?ans:[ans]).map(String));
          if(cSet.size === sSet.size && [...cSet].every(x => sSet.has(x))) earned += (q.points||1);
      }
    });

    let grade = total > 0 ? (2 + (4 * (earned / total))) : 2;
    if(grade<2) grade=2; if(grade>6) grade=6;

    db.run(`INSERT INTO submissions (test_id, student_id, student_name, student_class, answers, auto_grade, manual_points) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [testId, studentId, studentName, studentClass, JSON.stringify(answers), grade.toFixed(2), '{}'],
      function(err) { res.json({ success: true, grade: grade.toFixed(2) }); }
    );
  });
});

app.get('/api/submissions', (req, res) => {
  const sql = `SELECT s.id as submissionId, s.student_name as studentName, s.student_class as studentClass, s.submitted_at as submittedAt, s.auto_grade as autoGrade, s.manual_grade as manualGrade, t.title as testTitle FROM submissions s LEFT JOIN tests t ON s.test_id = t.id ORDER BY s.submitted_at DESC`;
  db.all(sql, [], (err, rows) => res.json(rows||[]));
});

app.get('/api/submission/:id', (req, res) => {
  db.get(`SELECT s.*, t.title, t.questions FROM submissions s LEFT JOIN tests t ON s.test_id = t.id WHERE s.id = ?`, [req.params.id], (err, row) => {
    if(!row) return res.status(404).json({error:'Not found'});
    const q = row.questions ? JSON.parse(row.questions) : [];
    const a = JSON.parse(row.answers||'{}');
    const mp = JSON.parse(row.manual_points||'{}');
    
    const result = q.map((qu, i) => {
        const sans = a[`q${i}`];
        let correct = false;
        if(qu.type === 'single') correct = parseInt(sans) === qu.correct;
        else if(qu.type === 'multiple') {
            const c = new Set((qu.correct||[]).map(String));
            const s = new Set((Array.isArray(sans)?sans:[sans]).map(String));
            correct = (c.size===s.size && [...c].every(x=>s.has(x)));
        }
        return { question: qu.text, type: qu.type, points: qu.points||1, options: qu.options, correctAnswer: qu.correct, studentAnswer: sans, isCorrect: correct, manualPoints: mp[i], image: qu.image };
    });

    res.json({
        studentName: row.student_name, studentClass: row.student_class, testTitle: row.title||'Deleted',
        submittedAt: row.submitted_at, autoGrade: row.auto_grade, manualGrade: row.manual_grade,
        teacherComment: row.teacher_comment, questions: q, answers: result, manualPoints: mp
    });
  });
});

app.delete('/api/submissions/:id', (req, res) => {
  db.run("DELETE FROM submissions WHERE id = ?", [req.params.id], (err) => res.json({ deleted: true }));
});

app.post('/api/submission-points/:id', (req, res) => {
  const { questionIndex, points } = req.body;
  db.get("SELECT manual_points FROM submissions WHERE id = ?", [req.params.id], (err, row) => {
    let cur = JSON.parse(row.manual_points || '{}');
    cur[questionIndex] = parseFloat(points);
    db.run("UPDATE submissions SET manual_points = ? WHERE id = ?", [JSON.stringify(cur), req.params.id], (err) => res.json({success:true}));
  });
});

app.post('/api/save-review/:id', (req, res) => {
  const { manualGrade, teacherComment } = req.body;
  db.run("UPDATE submissions SET manual_grade = ?, teacher_comment = ? WHERE id = ?", [manualGrade, teacherComment, req.params.id], (err) => res.json({ success: true }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));