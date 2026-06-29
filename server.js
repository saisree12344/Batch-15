const express = require('express');
const cors = require('cors');
const path = require('path');
const { setupDatabase } = require('./database');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

// Serve static files (express will serve index.html by default for '/')
app.use(express.static(path.join(__dirname)));

let db;

app.post('/api/students', async (req, res) => {
    const { roll_no, name, email, college_name, cgpa } = req.body;
    
    try {
        // Upsert student record
        const existing = await db.get('SELECT * FROM students WHERE roll_no = ?', [roll_no]);
        if (existing) {
            await db.run(
                'UPDATE students SET name = ?, email = ?, college_name = ?, cgpa = ? WHERE roll_no = ?',
                [name, email, college_name, cgpa, roll_no]
            );
        } else {
            await db.run(
                'INSERT INTO students (roll_no, name, email, college_name, cgpa) VALUES (?, ?, ?, ?, ?)',
                [roll_no, name, email, college_name, cgpa]
            );
        }
        res.json({ status: 'success', roll_no });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/students/:roll_no', async (req, res) => {
    try {
        const student = await db.get('SELECT * FROM students WHERE roll_no = ?', [req.params.roll_no]);
        if (!student) return res.status(404).json({ error: 'Student not found' });
        res.json(student);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sessions', async (req, res) => {
    const { user_id } = req.body;
    const session_id = Date.now().toString(); // Simple ID for now

    try {
        await db.run(
            'INSERT INTO sessions (id, user_id) VALUES (?, ?)',
            [session_id, user_id || 'anonymous']
        );
        res.json({ session_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/events', async (req, res) => {
    const { session_id, event_type, data } = req.body;

    try {
        await db.run(
            'INSERT INTO events (session_id, event_type, data) VALUES (?, ?, ?)',
            [session_id, event_type, JSON.stringify(data)]
        );

        // Update integrity score if penalty exists in data
        if (data && data.penalty) {
            await db.run(
                'UPDATE sessions SET trust_score = MAX(0, trust_score - ?) WHERE id = ?',
                [data.penalty, session_id]
            );
        }

        res.json({ status: 'logged' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Real-time payload endpoint to save base64 snapshots
app.post('/api/snapshots', async (req, res) => {
    const { session_id, snapshot_data } = req.body;
    
    // In a high-traffic production system, we'd stream this to AWS S3/Cloud Storage.
    // For this SQLite demonstrator, we store the recent few or just one per minute to avoid huge DBs.
    try {
        await db.run(
            'INSERT INTO snapshots (session_id, snapshot_data) VALUES (?, ?)',
            [session_id, snapshot_data]
        );

        // Optional: Keep only the latest 10 snapshots per session to prevent DB bloat
        await db.run(
            `DELETE FROM snapshots WHERE id NOT IN (
                SELECT id FROM snapshots WHERE session_id = ? ORDER BY id DESC LIMIT 10
            )`,
            [session_id]
        );

        res.json({ status: 'snapshot_saved' });
    } catch (error) {
        console.error("Snapshot save error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/sessions/:id', async (req, res) => {
    try {
        const session = await db.get('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
        const events = await db.all('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp DESC', [req.params.id]);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json({ ...session, events });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function start() {
    db = await setupDatabase();
    app.listen(PORT, () => {
        console.log(`AI Proctoring Server running at http://localhost:${PORT}`);
    });
}

start();
