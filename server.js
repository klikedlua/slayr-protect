
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { minifyLuau } = require("./lib/transform");

const app = express();

if (
    process.env.NODE_ENV === "production" &&
    (!process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET.length < 32)
) {
    throw new Error(
        "SESSION_SECRET must be set to a random value of at least 32 characters in production."
    );
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

const port = Number(process.env.PORT || 3000);

const dataDir =
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    process.env.DATA_DIR ||
    path.join(__dirname, "data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "slayr.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source_bytes INTEGER NOT NULL DEFAULT 0,
    output_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({
    extended: false,
    limit: "300kb"
}));

app.use(session({
    name: "slayr.sid",
    secret:
        process.env.SESSION_SECRET ||
        "local-development-secret-change-before-deploy-000",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 86400000
    }
}));

const generalLimit = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false
});

const authLimit = rateLimit({
    windowMs: 900000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false
});

app.use("/api", generalLimit);
app.use("/api/auth", authLimit);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 512 * 1024,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        if (/\.(lua|luau)$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error("Only .lua and .luau files are accepted."));
        }
    }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "slayr-protect"
    });
});

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Please log in to continue."
        });
    }

    next();
}

function dashboard(userId) {
    const user = db.prepare(
        "SELECT id, username, created_at FROM users WHERE id = ?"
    ).get(userId);

    if (!user) return null;

    const stats = db.prepare(`
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(source_bytes), 0) AS sourceBytes,
            COALESCE(SUM(output_bytes), 0) AS outputBytes
        FROM jobs
        WHERE user_id = ?
    `).get(userId);

    const recent = db.prepare(`
        SELECT id, name, description, source_bytes,
               output_bytes, created_at
        FROM jobs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 8
    `).all(userId);

    return { user, stats, recent };
}

function startSession(req, userId, res) {
    req.session.regenerate(err => {
        if (err) {
            return res.status(500).json({
                error: "Could not start your session."
            });
        }

        req.session.userId = userId;

        req.session.save(saveErr => {
            if (saveErr) {
                return res.status(500).json({
                    error: "Could not save your session."
                });
            }

            res.json({
                dashboard: dashboard(userId)
            });
        });
    });
}

app.post("/api/auth/register", async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        return res.status(400).json({
            error: "Username must be 3–24 characters using letters, numbers, or underscores."
        });
    }

    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({
            error: "Password must be 8–128 characters."
        });
    }

    try {
        const hash = await bcrypt.hash(password, 12);

        const result = db.prepare(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)"
        ).run(username, hash);

        startSession(req, Number(result.lastInsertRowid), res);
    } catch {
        return res.status(409).json({
            error: "That username is already taken."
        });
    }
});

app.post("/api/auth/login", async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const user = db.prepare(
        "SELECT id, password_hash FROM users WHERE username = ?"
    ).get(username);

    if (
        !user ||
        !(await bcrypt.compare(password, user.password_hash))
    ) {
        return res.status(401).json({
            error: "Incorrect username or password."
        });
    }

    startSession(req, user.id, res);
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({
                error: "Could not log out."
            });
        }

        res.clearCookie("slayr.sid");
        res.json({ ok: true });
    });
});

app.get("/api/me", requireAuth, (req, res) => {
    const data = dashboard(req.session.userId);

    if (!data) {
        return res.status(401).json({
            error: "Account not found."
        });
    }

    res.json(data);
});

app.post("/api/change-password", requireAuth, async (req, res) => {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    const row = db.prepare(
        "SELECT password_hash FROM users WHERE id = ?"
    ).get(req.session.userId);

    if (
        !row ||
        !(await bcrypt.compare(currentPassword, row.password_hash))
    ) {
        return res.status(400).json({
            error: "Your current password is incorrect."
        });
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
        return res.status(400).json({
            error: "New password must be 8–128 characters."
        });
    }

    db.prepare(
        "UPDATE users SET password_hash = ? WHERE id = ?"
    ).run(
        await bcrypt.hash(newPassword, 12),
        req.session.userId
    );

    res.json({ ok: true });
});

function transform(req, res, source) {
    const name = String(req.body.name || "").trim().slice(0, 80);
    const description = String(req.body.description || "")
        .trim()
        .slice(0, 300);

    if (!name) {
        return res.status(400).json({
            error: "Enter a script name."
        });
    }

    if (!source.trim()) {
        return res.status(400).json({
            error: "Paste or upload some Luau code first."
        });
    }

    if (Buffer.byteLength(source, "utf8") > 200 * 1024) {
        return res.status(413).json({
            error: "Code is limited to 200 KB per job."
        });
    }

    const output = minifyLuau(source);

    db.prepare(`
        INSERT INTO jobs
            (user_id, name, description, source_bytes, output_bytes)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        req.session.userId,
        name,
        description,
        Buffer.byteLength(source),
        Buffer.byteLength(output)
    );

    res.json({
        output,
        stats: dashboard(req.session.userId).stats,
        notice: "Basic minification complete — this is not strong obfuscation."
    });
}

app.post("/api/obfuscate", requireAuth, (req, res) => {
    transform(req, res, String(req.body.code || ""));
});

app.post(
    "/api/obfuscate-file",
    requireAuth,
    upload.single("file"),
    (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: "Choose a .lua or .luau file (max 512 KB)."
            });
        }

        transform(req, res, req.file.buffer.toString("utf8"));
    }
);

app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            error: "File upload failed or exceeds 512 KB."
        });
    }

    if (err) {
        return res.status(400).json({
            error: err.message || "Request could not be processed."
        });
    }

    res.status(400).json({
        error: "Request could not be processed."
    });
});

const server = app.listen(port, () => {
    console.log(`Slayr Protect listening on ${port}`);
});

function shutdown() {
    server.close(() => {
        db.close();
        process.exit(0);
    });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = { app };
