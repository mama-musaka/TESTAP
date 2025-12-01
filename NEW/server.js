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

// API
app.get('/api/tests', (req, res) => {
  db.all('SELECT id, title, question_count FROM tests ORDER BY id DESC', (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/grade/:id', (req, res) => {
  db.get('SELECT questions FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).send('Not found');
    const qs = JSON.parse(row.questions);
    let correct = 0;
    let total_mcq = 0;
    const mistakes = [];
    const open_answers = [];

    qs.forEach((q, i) => {
      const userAnswer = req.body[`q${i}`];

      if (q.type === 'mcq') {
        total_mcq++;
        const ans = parseInt(userAnswer);
        if (ans === q.correct) {
          correct++;
        } else {
          mistakes.push({
            question: q.text,
            your: ans != null ? q.options[ans] : "No answer",
            correct: q.options[q.correct]
          });
        }
      } else if (q.type === 'open') {
        open_answers.push(userAnswer || "(empty)");
      }
    });

    const percent = total_mcq > 0 ? Math.round((correct / total_mcq) * 100) : 0;
    const grade = total_mcq === 0 ? '—' : (percent >= 90 ? 'A' : percent >= 80 ? 'B' : percent >= 70 ? 'C' : percent >= 60 ? 'D' : 'F');

    res.json({
      correct,
      total_mc: total_mcq,
      open_count: open_answers.length,
      percent,
      grade,
      mistakes,
      open_answers
    });
  });
});

app.get('/api/tests/:id', (req, res) => {
  db.get('SELECT * FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (row) row.questions = JSON.parse(row.questions);
    res.json(row || {});
  });
});

app.post('/api/grade/:id', (req, res) => {
  db.get('SELECT questions FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    const qs = JSON.parse(row.questions);
    let correct = 0;
    const mistakes = [];
    qs.forEach((q, i) => {
      const ans = parseInt(req.body[`q${i}`]);
      if (ans === q.correct) correct++;
      else mistakes.push({ question: q.text, your: ans != null ? q.options[ans] : "No answer", correct: q.options[q.correct] });
    });
    const percent = Math.round((correct / qs.length) * 100);
    const grade = percent >= 90 ? 'A' : percent >= 80 ? 'B' : percent >= 70 ? 'C' : percent >= 60 ? 'D' : 'F';
    res.json({ correct, total: qs.length, percent, grade, mistakes });
  });
});

app.delete('/api/tests/:id', (req, res) => {
  db.run('DELETE FROM tests WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/import', (req, res) => {
  const { title, questions } = req.body;
  db.run('INSERT INTO tests (title, questions, question_count) VALUES (?, ?, ?)',
    [title, JSON.stringify(questions), questions.length]);
  res.json({ success: true });
});

app.get('/api/export/:id', (req, res) => {
  db.get('SELECT title, questions FROM tests WHERE id = ?', [req.params.id], (err, row) => {
    if (row) row.questions = JSON.parse(row.questions);
    res.json(row);
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(3000, () => {
  console.log('App running → http://localhost:3000');
});