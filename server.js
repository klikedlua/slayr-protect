"use strict";

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { transformLuau } = require("./lib/transform");

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction &&
    (!process.env.SESSION_SECRET ||
     process.env.SESSION_SECRET.length < 32)) {
    throw new Error(
        "SESSION_SECRET must be set to a random value of at least 32 characters in production."
    );
}

const SESSION_SECRET =
    process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");

const DATA_DIR = process.env.DATA_DIR ||
    path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "slayr.json");

function loadDatabase() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        if (parsed && Array.isArray(parsed.users) &&
            Array.isArray(parsed.jobs)) {
            return parsed;
        }
    } catch (error) {
        if (error.code !== "ENOENT" &&
            !(error instanceof SyntaxError)) {
            console.error("Database read error:", error.message);
        }
    }

    return { users: [], jobs: [] };
}

let db = loadDatabase();

function saveDatabase() {
    const temporary = DB_FILE + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(db, null, 2), {
        mode: 0o600
    });
    fs.renameSync(temporary, DB_FILE);
}

app.disable("x-powered-by");
app.set("trust proxy", isProduction ? 1 : false);

app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: false, limit: "3mb" }));

app.use(session({
    name: "slayr.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Please log in to continue."
        });
    }

    next();
}

function currentUser(req) {
    return db.users.find(
        user => user.id === req.session.userId
    );
}

function dashboard(userId) {
    const userJobs = db.jobs.filter(
        job => job.userId === userId
    );

    return {
        stats: {
            scriptsObfuscated: userJobs.length,
            bytesProcessed: userJobs.reduce(
                (sum, job) => sum + job.sourceBytes, 0
            ),
            bytesOutput: userJobs.reduce(
                (sum, job) => sum + job.outputBytes, 0
            )
        },
        recentJobs: userJobs.slice(-10).reverse().map(job => ({
            name: job.name,
            description: job.description,
            createdAt: job.createdAt,
            sourceBytes: job.sourceBytes,
            outputBytes: job.outputBytes
        }))
    };
}

// Register
app.post("/api/register", async (req, res, next) => {
    try {
        const username = typeof req.body.username === "string"
            ? req.body.username.trim()
            : "";

        const password = typeof req.body.password === "string"
            ? req.body.password
            : "";

        if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
            return res.status(400).json({
                error: "Username must be 3–24 characters using letters, numbers, _ or -."
            });
        }

        if (password.length < 10 || password.length > 128) {
            return res.status(400).json({
                error: "Password must be between 10 and 128 characters."
            });
        }

        if (db.users.some(
            user => user.username.toLowerCase() === username.toLowerCase()
        )) {
            return res.status(409).json({
                error: "That username is already taken."
            });
        }

        const user = {
            id: crypto.randomUUID(),
            username,
            passwordHash: await bcrypt.hash(password, 12),
            createdAt: new Date().toISOString()
        };

        db.users.push(user);
        saveDatabase();

        req.session.userId = user.id;

        req.session.save(error => {
            if (error) return next(error);

            res.status(201).json({
                user: {
                    username: user.username
                }
            });
        });
    } catch (error) {
        next(error);
    }
});

// Login
app.post("/api/login", async (req, res, next) => {
    try {
        const username = typeof req.body.username === "string"
            ? req.body.username.trim()
            : "";

        const password = typeof req.body.password === "string"
            ? req.body.password
            : "";

        const user = db.users.find(
            item => item.username.toLowerCase() === username.toLowerCase()
        );

        if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
            return res.status(401).json({
                error: "Invalid username or password."
            });
        }

        req.session.regenerate(error => {
            if (error) return next(error);

            req.session.userId = user.id;

            req.session.save(saveError => {
                if (saveError) return next(saveError);

                res.json({
                    user: {
                        username: user.username
                    }
                });
            });
        });
    } catch (error) {
        next(error);
    }
});

// Current session
app.get("/api/me", requireAuth, (req, res) => {
    const user = currentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "Account not found. Please log in again."
        });
    }

    res.json({
        user: {
            username: user.username,
            createdAt: user.createdAt
        }
    });
});

// Dashboard
app.get("/api/dashboard", requireAuth, (req, res) => {
    const user = currentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "Account not found."
        });
    }

    res.json({
        user: {
            username: user.username,
            createdAt: user.createdAt
        },
        ...dashboard(user.id)
    });
});

// Transform Luau
app.post("/api/obfuscate", requireAuth, (req, res) => {
    try {
        const user = currentUser(req);

        if (!user) {
            return res.status(401).json({
                error: "Please log in again."
            });
        }

        const name = typeof req.body.name === "string"
            ? req.body.name.trim().slice(0, 100)
            : "";

        const description = typeof req.body.description === "string"
            ? req.body.description.trim().slice(0, 500)
            : "";

        const source = req.body.source;
        const profile = req.body.profile || "standard";

        if (!name) {
            return res.status(400).json({
                error: "Script name is required."
            });
        }

        if (typeof source !== "string" || !source.trim()) {
            return res.status(400).json({
                error: "Enter or upload Luau source code first."
            });
        }

        if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
            return res.status(413).json({
                error: "Source exceeds the 1 MB limit."
            });
        }

        const result = transformLuau(source, { profile });

        const job = {
            id: crypto.randomUUID(),
            userId: user.id,
            name,
            description,
            createdAt: new Date().toISOString(),
            sourceBytes: result.inputBytes,
            outputBytes: result.outputBytes
        };

        db.jobs.push(job);
        saveDatabase();

        res.json({
            output: result.output,
            stats: {
                inputBytes: result.inputBytes,
                outputBytes: result.outputBytes,
                savedBytes: result.inputBytes - result.outputBytes,
                renamedBindings: result.renamedBindings,
                encodedStrings: result.encodedStrings,
                encodedProperties: result.encodedProperties
            },
            profile: result.profile,
            notice: result.profile === "strong"
                ? `${result.renamedBindings} locals renamed; ${result.encodedStrings} strings and ${result.encodedProperties} property names use randomized byte-stream encoding with payload checks. The decoder remains reversible and removable. Test the output before use.`
                : `${result.renamedBindings} local names renamed. Test the output before use.`
        });
    } catch (error) {
        res.status(400).json({
            error: error.message || "Transformation failed."
        });
    }
});

// Settings
app.get("/api/settings", requireAuth, (req, res) => {
    const user = currentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "Account not found."
        });
    }

    res.json({
        username: user.username,
        createdAt: user.createdAt
    });
});

// Logout
app.post("/api/logout", (req, res, next) => {
    req.session.destroy(error => {
        if (error) return next(error);

        res.clearCookie("slayr.sid", {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax"
        });

        res.json({ success: true });
    });
});

// Frontend files
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Unknown API routes should return JSON.
app.use("/api", (req, res) => {
    res.status(404).json({
        error: "API endpoint not found."
    });
});

// Error handler
app.use((error, req, res, next) => {
    console.error("Slayr Protect error:", error.message);

    if (res.headersSent) return next(error);

    res.status(500).json({
        error: "An internal server error occurred."
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Slayr Protect listening on ${PORT}`);
});
