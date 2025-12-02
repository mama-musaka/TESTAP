const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('tests.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Таблици
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    questions TEXT,
    question_count INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    testId INTEGER,
    studentName TEXT,
    studentClass TEXT,
    answers TEXT,
    autoGrade TEXT,
    manualGrade TEXT DEFAULT '—',
    manualPoints TEXT DEFAULT '{}',
    submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// API
app.get('/api/tests', (req, res) => {
  db.all('SELECT id, title, question_count FROM tests ORDER BY id DESC', [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/tests', (req, res) => {
  const { title, questions } = req.body;
  db.run('INSERT INTO tests (title, questions, question_count) VALUES (?, ?, ?)',
    [title, JSON.stringify(questions), questions.length],
    function() { res.json({ success: true }); }
  );
});

app.get('/api/tests/:id', (req, res) => {
  db.get('SELECT * FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (row) row.questions = JSON.parse(row.questions);
    res.json(row || {});
  });
});

app.post('/api/grade/:id', (req, res) => {
  db.get('SELECT questions FROM tests WHERE id = ?', [req.params.id], (err, testRow) => {
    if (!testRow) return res.status(404).json({error: 'not found'});

    const qs = JSON.parse(testRow.questions);
    let earned = 0;
    let total = 0;

    qs.forEach((q, i) => {
      const pts = q.points || 10;
      total += pts;

      if (q.type === 'open') {
        earned += pts;
      } else {
        const user = req.body[`q${i}`] || [];
        const userArr = Array.isArray(user) ? user.map(Number) : [Number(user)].filter(n => !isNaN(n));
        const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
        if (JSON.stringify(userArr.sort()) === JSON.stringify(correctArr.sort())) {
          earned += pts;
        }
      }
    });

    const percent = total ? Math.round((earned / total) * 100) : 0;
    const grade = percent >= 96 ? '6' : percent >= 83 ? '5' : percent >= 66 ? '4' : percent >= 50 ? '3' : '2';

    db.run('INSERT INTO submissions (testId, studentName, studentClass, answers, autoGrade) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, req.body.studentName || 'Анонимен', req.body.studentClass || '', JSON.stringify(req.body), grade],
      function() {
        res.json({ success: true, grade });
      }
    );
  });
});

app.get('/api/submissions', (req, res) => {
  db.all(`
    SELECT 
      s.id AS submissionId,
      s.studentName,
      s.studentClass,
      s.autoGrade,
      s.manualGrade,
      s.submittedAt,
      t.title AS testTitle
    FROM submissions s
    LEFT JOIN tests t ON s.testId = t.id
    ORDER BY s.submittedAt DESC
  `, (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/submission/:id', (req, res) => {
  db.get('SELECT s.*, t.questions, t.title AS testTitle FROM submissions s LEFT JOIN tests t ON s.testId = t.id WHERE s.id = ?', [req.params.id], (err, row) => {
    if (!row) return res.status(404).send();

    const qs = JSON.parse(row.questions);
    const answers = JSON.parse(row.answers || '{}');
    const manualPoints = JSON.parse(row.manualPoints || '{}');

    const result = qs.map((q, i) => {
      const user = answers[`q${i}`] || [];
      const userArr = Array.isArray(user) ? user : [user];

      if (q.type === 'open') {
        return { type: 'open', question: q.text, studentAnswer: userArr[0] || '', points: q.points || 10 };
      }

      const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
      const isCorrect = userArr.map(Number).sort().join() === correctArr.sort().join();
      return {
        type: q.type,
        question: q.text,
        options: q.options,
        correctAnswer: q.correct,
        studentAnswer: userArr,
        isCorrect,
        points: q.points || 10
      };
    });

    res.json({
      studentName: row.studentName,
      studentClass: row.studentClass,
      submittedAt: row.submittedAt,
      testTitle: row.testTitle,
      answers: result,
      autoGrade: row.autoGrade,
      manualPoints: row.manualPoints,
      questions: qs
    });
  });
});

app.post('/api/submission-points/:id', (req, res) => {
  const { questionIndex, points } = req.body;
  db.get('SELECT manualPoints FROM submissions WHERE id = ?', [req.params.id], (err, r) => {
    let obj = {};
    try { obj = JSON.parse(r?.manualPoints || '{}'); } catch {}
    obj[questionIndex] = Number(points);
    db.run('UPDATE submissions SET manualPoints = ? WHERE id = ?', [JSON.stringify(obj), req.params.id], () => {
      res.json({ success: true });
    });
  });
});

app.post('/api/grade-manual/:id', (req, res) => {
  db.run('UPDATE submissions SET manualGrade = ? WHERE id = ?', [req.body.manualGrade, req.params.id], () => {
    res.json({ success: true });
  });
});

app.delete('/api/submissions/:id', (req, res) => {
  db.run('DELETE FROM submissions WHERE id = ?', [req.params.id], () => {
    res.json({ success: true });
  });
});

// РАБОТЕЩ FALLBACK ЗА NODE.JS 24
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => {
  console.log('Сървърът работи на http://localhost:3000');
  console.log('Дашборд: http://localhost:3000/dashboard.html');
});