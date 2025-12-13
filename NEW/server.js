const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('tests.db', (err) => {
    if (err) console.error("DB Error:", err.message);
    else console.log("Connected to database.");
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// === DATABASE SETUP & SMART MIGRATION ===
db.serialize(() => {
  // 1. Create Tables
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    full_name TEXT,
    student_class TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER,
    title TEXT,
    questions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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

  // 2. Fix Old Column Names (camelCase -> snake_case)
  db.all("PRAGMA table_info(submissions)", (err, rows) => {
    if (err) return;
    const columns = rows.map(r => r.name);
    
    const renames = [
        { old: 'testId', new: 'test_id' },
        { old: 'studentName', new: 'student_name' },
        { old: 'studentClass', new: 'student_class' },
        { old: 'autoGrade', new: 'auto_grade' },
        { old: 'manualGrade', new: 'manual_grade' },
        { old: 'manualPoints', new: 'manual_points' },
        { old: 'teacherComment', new: 'teacher_comment' },
        { old: 'submittedAt', new: 'submitted_at' }
    ];

    renames.forEach(m => {
        if (columns.includes(m.old) && !columns.includes(m.new)) {
            console.log(`Migrating column: ${m.old} -> ${m.new}`);
            db.run(`ALTER TABLE submissions RENAME COLUMN ${m.old} TO ${m.new}`, (err) => {});
        }
    });

    // 3. Add Missing Columns (Safe-guard)
    const requiredCols = [
        { name: 'manual_points', type: 'TEXT' },
        { name: 'manual_grade', type: 'REAL' },
        { name: 'teacher_comment', type: 'TEXT' },
        { name: 'student_id', type: 'INTEGER' },
        { name: 'creator_id', type: 'INTEGER', table: 'tests' }
    ];

    setTimeout(() => {
        requiredCols.forEach(col => {
            const table = col.table || 'submissions';
            db.run(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`, (err) => {});
        });
    }, 1000);
  });
});

// === AUTH ROUTES ===

// Register
app.post('/api/register', (req, res) => {
    const { username, password, role, fullName, studentClass, secretCode } = req.body;

    if (role === 'teacher' && secretCode !== 'TEACHER123') {
        return res.status(403).json({ error: 'Грешен учителски код!' });
    }
    if (role === 'admin' && secretCode !== 'ADMIN123') {
        return res.status(403).json({ error: 'Грешен администраторски код!' });
    }

    db.run(`INSERT INTO users (username, password, role, full_name, student_class) VALUES (?, ?, ?, ?, ?)`, 
        [username, password, role, fullName, studentClass], 
        function(err) {
            if (err) {
                if(err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Потребителското име вече е заето.' });
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, role, full_name, student_class FROM users WHERE username = ? AND password = ?", 
        [username, password], (err, row) => {
            if (!row) return res.status(401).json({ error: 'Грешно име или парола' });
            res.json({ success: true, user: row });
        }
    );
});

// === TEST ROUTES ===

// Get Tests
app.get('/api/tests', (req, res) => {
  db.all("SELECT id, title, creator_id, (SELECT COUNT(*) FROM json_each(questions)) as question_count FROM tests ORDER BY id DESC", [], (err, rows) => {
    if(err) return res.status(500).json([]);
    res.json(rows);
  });
});

// Get Single Test
app.get('/api/tests/:id', (req, res) => {
  db.get("SELECT * FROM tests WHERE id = ?", [req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Test not found' });
    try { row.questions = JSON.parse(row.questions); } catch(e) { row.questions = []; }
    res.json(row);
  });
});

// Create Test
app.post('/api/tests', (req, res) => {
  const { title, questions, creatorId } = req.body;
  db.run("INSERT INTO tests (title, questions, creator_id) VALUES (?, ?, ?)", [title, JSON.stringify(questions), creatorId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

// Delete Test
app.delete('/api/tests/:id', (req, res) => {
  db.run("DELETE FROM tests WHERE id = ?", [req.params.id], (err) => {
    res.json({ deleted: true });
  });
});

// === GRADING & SUBMISSIONS ===

// Submit Test
app.post('/api/grade/:id', (req, res) => {
  const testId = req.params.id;
  const { answers, studentId, studentName, studentClass } = req.body;
  
  db.get("SELECT questions FROM tests WHERE id = ?", [testId], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Test not found' });
    
    let questions = [];
    try { questions = JSON.parse(row.questions); } catch(e){}
    
    let totalPoints = 0;
    let earnedPoints = 0;

    questions.forEach((q, i) => {
      const qPoints = parseInt(q.points) || 1;
      totalPoints += qPoints;
      const studentAns = answers[`q${i}`];

      if (q.type === 'single') {
        if (parseInt(studentAns) === q.correct) earnedPoints += qPoints;
      } else if (q.type === 'multiple') {
        const correctSet = new Set((q.correct || []).map(String));
        const studentArr = Array.isArray(studentAns) ? studentAns : (studentAns ? [studentAns] : []);
        const studentSet = new Set(studentArr.map(String));
        if (correctSet.size === studentSet.size && [...correctSet].every(x => studentSet.has(x))) {
           earnedPoints += qPoints;
        }
      }
    });

    let grade = totalPoints > 0 ? (2 + (4 * (earnedPoints / totalPoints))) : 2;
    if (grade < 2) grade = 2;
    if (grade > 6) grade = 6;

    db.run(`INSERT INTO submissions (test_id, student_id, student_name, student_class, answers, auto_grade, manual_points) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [testId, studentId, studentName, studentClass, JSON.stringify(answers), grade.toFixed(2), '{}'],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, grade: grade.toFixed(2) });
      }
    );
  });
});

// Get Submissions (Dashboard)
app.get('/api/submissions', (req, res) => {
  const sql = `
    SELECT s.id as submissionId, s.student_name as studentName, s.student_class as studentClass,
           s.submitted_at as submittedAt, s.auto_grade as autoGrade, s.manual_grade as manualGrade,
           t.title as testTitle
    FROM submissions s
    LEFT JOIN tests t ON s.test_id = t.id
    ORDER BY s.submitted_at DESC
  `;
  db.all(sql, [], (err, rows) => {
      if(err) console.error(err);
      res.json(rows || []);
  });
});

// Get Single Submission Detail
app.get('/api/submission/:id', (req, res) => {
  db.get(`
    SELECT s.*, t.title, t.questions 
    FROM submissions s
    LEFT JOIN tests t ON s.test_id = t.id
    WHERE s.id = ?
  `, [req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Not found' });
    
    const questions = row.questions ? JSON.parse(row.questions) : [];
    const answers = JSON.parse(row.answers || '{}');
    const manualPoints = JSON.parse(row.manual_points || '{}');

    const result = questions.map((q, i) => {
      let isCorrect = false;
      const studentAns = answers[`q${i}`];

      if (q.type === 'single') {
        isCorrect = parseInt(studentAns) === q.correct;
      } else if (q.type === 'multiple') {
        const correctSet = new Set((q.correct||[]).map(String));
        const studentArr = Array.isArray(studentAns) ? studentAns : (studentAns ? [studentAns] : []);
        const studentSet = new Set(studentArr.map(String));
        isCorrect = (correctSet.size === studentSet.size && [...correctSet].every(x => studentSet.has(x)));
      }

      return {
        question: q.text,
        type: q.type,
        points: q.points || 1,
        options: q.options,
        correctAnswer: q.correct,
        studentAnswer: studentAns,
        isCorrect: isCorrect,
        manualPoints: manualPoints[i]
      };
    });

    if(questions.length === 0 && Object.keys(answers).length > 0) {
        Object.keys(answers).forEach((key, i) => {
            result.push({
               question: "Въпросът е изтрит (Тестът е премахнат)",
               studentAnswer: answers[key],
               points: 0,
               type: 'unknown'
            });
        });
    }

    res.json({
      studentName: row.student_name,
      studentClass: row.student_class,
      testTitle: row.title || 'Изтрит Тест',
      submittedAt: row.submitted_at,
      autoGrade: row.auto_grade,
      manualGrade: row.manual_grade,
      teacherComment: row.teacher_comment,
      questions: questions,
      answers: result,
      manualPoints: row.manual_points
    });
  });
});

// Delete Submission
app.delete('/api/submissions/:id', (req, res) => {
  db.run("DELETE FROM submissions WHERE id = ?", [req.params.id], (err) => {
    res.json({ deleted: true });
  });
});

// Update Points (Open Questions)
app.post('/api/submission-points/:id', (req, res) => {
  const { questionIndex, points } = req.body;
  db.get("SELECT manual_points FROM submissions WHERE id = ?", [req.params.id], (err, row) => {
    let current = JSON.parse(row.manual_points || '{}');
    current[questionIndex] = parseFloat(points);
    db.run("UPDATE submissions SET manual_points = ? WHERE id = ?", [JSON.stringify(current), req.params.id], (err) => res.json({success:true}));
  });
});

// Save Final Review (Grade + Comment)
app.post('/api/save-review/:id', (req, res) => {
  const { manualGrade, teacherComment } = req.body;
  db.run("UPDATE submissions SET manual_grade = ?, teacher_comment = ? WHERE id = ?", 
    [manualGrade, teacherComment, req.params.id], 
    (err) => res.json({ success: true })
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));