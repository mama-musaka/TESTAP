const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('tests.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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
  submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Get all tests
app.get('/api/tests', (req, res) => {
  db.all('SELECT id, title, question_count FROM tests ORDER BY id DESC', (err, rows) => {
    res.json(rows || []);
  });
});

// Save new test
app.post('/api/tests', (req, res) => {
  const { title, questions } = req.body;
  db.run('INSERT INTO tests (title, questions, question_count) VALUES (?, ?, ?)',
    [title, JSON.stringify(questions), questions.length], () => res.json({ success: true }));
});

// Get one test
app.get('/api/tests/:id', (req, res) => {
  db.get('SELECT * FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (row) row.questions = JSON.parse(row.questions);
    res.json(row || {});
  });
});

// Grade and save submission
app.post('/api/grade/:id', (req, res) => {
  db.get('SELECT questions, title FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Test not found' });

    const qs = JSON.parse(row.questions);
    let correct = 0;
    let total_mcq = 0;
    const mistakes = [];
    const open_answers = [];

    qs.forEach((q, i) => {
      const userAns = req.body[`q${i}`] || [];

      if (q.type === 'open') {
        open_answers.push(Array.isArray(userAns) ? userAns[0] || '' : userAns);
      } else {
        total_mcq++;
        const user = Array.isArray(userAns) ? userAns.map(Number) : (userAns ? [Number(userAns)] : []);
        const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];

        const isCorrect = user.sort().join(',') === correctArr.sort().join(',');
        if (isCorrect) correct++;
        else {
          mistakes.push({
            question: q.text,
            your: user.length ? user.map(n => q.options[n]).join(', ') : '(no answer)',
            correct: correctArr.map(n => q.options[n]).join(', ')
          });
        }
      }
    });

    const percent = total_mcq > 0 ? Math.round((correct / total_mcq) * 100) : 0;
    const autoGrade = total_mcq === 0 ? '—' : (percent >= 96 ? '6' : percent >= 83 ? '5' : percent >= 66 ? '4' : percent >= 50 ? '3' : '2');

    db.run('INSERT INTO submissions (testId, studentName, studentClass, answers, autoGrade) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, req.body.studentName || 'Anonymous', req.body.studentClass || '', JSON.stringify(req.body), autoGrade],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          correct,
          total_mc: total_mcq,
          open_count: open_answers.length,
          percent,
          grade: autoGrade,
          mistakes,
          open_answers
        });
      });
  });
});

// Delete test
app.delete('/api/tests/:id', (req, res) => {
  db.run('DELETE FROM tests WHERE id = ?', [req.params.id]);
  db.run('DELETE FROM submissions WHERE testId = ?', [req.params.id]);
  res.json({ success: true });
});

// Import test
app.post('/api/import', (req, res) => {
  const { title, questions } = req.body;
  db.run('INSERT INTO tests (title, questions, question_count) VALUES (?, ?, ?)',
    [title, JSON.stringify(questions), questions.length]);
  res.json({ success: true });
});

// Export test
app.get('/api/export/:id', (req, res) => {
  db.get('SELECT title, questions FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (row) row.questions = JSON.parse(row.questions);
    res.json(row);
  });
});

// Get all submissions – FIXED
app.get('/api/submissions', (req, res) => {
  db.all('SELECT s.id AS submissionId, s.studentName, s.studentClass, s.autoGrade, s.manualGrade, s.submittedAt, t.id AS testId, t.title AS testTitle FROM submissions s LEFT JOIN tests t ON s.testId = t.id ORDER BY s.submittedAt DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const data = {};
    (rows || []).forEach(row => {
      const testId = row.testId || 'unknown';
      data[testId] = data[testId] || [];
      data[testId].push(row);
    });
    res.json(data);
  });
});

// Update manual grade
app.post('/api/grade-manual/:id', (req, res) => {
  const { manualGrade } = req.body;
  db.run('UPDATE submissions SET manualGrade = ? WHERE id = ?', [manualGrade, req.params.id], (err) => {
    res.json({ success: !err });
  });
});

// Get submission for manual grading – FIXED studentAns HANDLING
app.get('/api/submission/:id', (req, res) => {
  db.get('SELECT s.*, t.questions, t.title AS testTitle FROM submissions s LEFT JOIN tests t ON s.testId = t.id WHERE s.id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Not found' });

    const qs = JSON.parse(row.questions);
    const studentAnswers = row.answers ? JSON.parse(row.answers) : {};

    const answers = qs.map((q, i) => {
      let studentAns = studentAnswers[`q${i}`] || [];
      if (!Array.isArray(studentAns)) studentAns = [studentAns];

      if (q.type === 'open') {
        return { type: 'open', question: q.text, studentAnswer: studentAns[0] || '' };
      } else {
        const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
        const isCorrect = studentAns.sort().join(',') === correctArr.sort().join(',');
        return { type: q.type, question: q.text, correctAnswer: q.correct, studentAnswer: studentAns, isCorrect };
      }
    });

    res.json({
      studentName: row.studentName,
      studentClass: row.studentClass,
      submittedAt: row.submittedAt,
      testTitle: row.testTitle,
      answers,
      autoGrade: row.autoGrade
    });
  });
});

// NEW – Delete submission (grades and takes)
app.delete('/api/submissions/:id', (req, res) => {
  db.run('DELETE FROM submissions WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(3000, () => {
  console.log('App running → http://localhost:3000');
  console.log('Dashboard → http://localhost:3000/dashboard.html');
});