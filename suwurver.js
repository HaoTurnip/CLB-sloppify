const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const chalk = require('chalk');
require('dotenv').config();

const app = express();
// Enable trust proxy - add this BEFORE other middleware
app.set('trust proxy', 1);  // Trust first proxy

// Enhanced security middleware
app.use(helmet()); // Adds various HTTP headers for security
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    maxAge: 600
}));
app.use(express.json({ limit: '10kb' }));

// Rate limiting configuration
const rateLimiters = {
    global: rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        skipFailedRequests: true, // Don't count failed requests
        handler: (req, res) => {
            console.log(chalk.yellow(`Rate limit exceeded for IP: ${req.ip}`));
            res.status(429).json({ error: 'Too many requests, please try again later.' });
        }
    }),
    votes: rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            console.log(chalk.yellow(`Vote rate limit exceeded for IP: ${req.ip}`));
            res.status(429).json({ error: 'Vote limit exceeded, please try again later.' });
        }
    }),
    sync: rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            console.log(chalk.yellow(`Sync rate limit exceeded for IP: ${req.ip}`));
            res.status(429).json({ error: 'Sync limit exceeded, please try again later.' });
        }
    })
};

// Apply global rate limiter
app.use(rateLimiters.global);

// GitHub OAuth settings
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    console.error(chalk.red.bold('GitHub OAuth credentials are not set.'));
    process.exit(1);
}

// Enhanced logging setup
const LOG_LEVELS = {
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
    DEBUG: 'DEBUG'
};

class Logger {
    constructor() {
        this.logs = [];
        this.LOGS_DIR = path.resolve('logs');
        this.setupLogsDirectory();
    }

    async setupLogsDirectory() {
        try {
            await fs.mkdir(this.LOGS_DIR, { recursive: true });
        } catch (error) {
            console.error(chalk.red('Failed to create logs directory:', error));
        }
    }

    formatLog(level, message, metadata = {}) {
        const timestamp = new Date().toISOString();
        const colorize = {
            [LOG_LEVELS.INFO]: chalk.blue,
            [LOG_LEVELS.WARN]: chalk.yellow,
            [LOG_LEVELS.ERROR]: chalk.red,
            [LOG_LEVELS.DEBUG]: chalk.gray
        };

        const logEntry = {
            timestamp,
            level,
            message,
            ...metadata
        };

        // Console output with colors
        console.log(
            `${chalk.green(timestamp)} [${colorize[level](level)}] ${message}`,
            Object.keys(metadata).length ? metadata : ''
        );

        return logEntry;
    }

    log(level, message, metadata) {
        const logEntry = this.formatLog(level, message, metadata);
        this.logs.push(JSON.stringify(logEntry) + '\n');
    }

    async saveLogs() {
        if (this.logs.length === 0) return;

        const logFile = path.join(this.LOGS_DIR, `log_${Date.now()}.jsonl`);
        try {
            await fs.writeFile(logFile, this.logs.join(''));
            this.logs = [];
            this.log(LOG_LEVELS.INFO, `Logs saved to ${logFile}`);
        } catch (error) {
            console.error(chalk.red('Error saving logs:', error));
        }
    }
}

const logger = new Logger();

// Save logs every 5 minutes
setInterval(() => logger.saveLogs(), 15 * 60 * 1000);

// Enhanced request logging middleware
app.use((req, res, next) => {
    const startTime = Date.now();

    // Log request
    logger.log(LOG_LEVELS.INFO, `Incoming ${req.method} request`, {
        url: req.url,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        body: req.method !== 'GET' ? req.body : undefined
    });

    // Log response
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const level = res.statusCode >= 400 ? LOG_LEVELS.ERROR : LOG_LEVELS.INFO;

        logger.log(level, `Request completed in ${duration}ms`, {
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            duration
        });
    });

    next();
});

// File paths
const COMMITS_FILE = path.resolve('commits.json');
const VOTES_FILE = path.resolve('votes.json');

async function fetchAllCommits(token) {
    const commits = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
        const response = await fetch(`https://api.github.com/repos/DishpitDev/Slopify/commits?per_page=100&page=${page}`, {
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.statusText}`);
        }

        const pageCommits = await response.json();
        commits.push(...pageCommits);

        // Check if there's another page (via the 'Link' header)
        const linkHeader = response.headers.get('Link');
        hasNextPage = linkHeader && linkHeader.includes('rel="next"');
        page++;
    }

    // Filter out commits authored by "Dishpit" or with messages starting with "Merge"
    const filteredCommits = commits.filter(c =>
        c.commit.author.name !== 'Dishpit' &&
        !c.commit.message.startsWith('Merge')
    );

    // Map and return the filtered commits with links
    return filteredCommits.map(c => ({
        id: c.sha,
        message: c.commit.message,
        author: c.commit.author.name,
        date: c.commit.author.date,
        link: c.html_url, // Include the link to the commit
    }));
}

// Helper functions (same as before)
async function readJsonFile(filename, defaultValue = []) {
    try {
        const data = await fs.readFile(filename, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.log(LOG_LEVELS.WARN, `File not found, creating new: ${filename}`);
        await fs.writeFile(filename, JSON.stringify(defaultValue));
        return defaultValue;
    }
}

async function writeJsonFile(filename, data) {
    try {
        await fs.writeFile(filename, JSON.stringify(data, null, 2));
        logger.log(LOG_LEVELS.INFO, `Successfully wrote to ${filename}`);
    } catch (error) {
        logger.log(LOG_LEVELS.ERROR, `Failed to write to ${filename}`, { error: error.message });
        throw error;
    }
}

// Enhanced GitHub OAuth endpoint
app.get('/auth/github', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        logger.log(LOG_LEVELS.WARN, 'GitHub auth attempted without code');
        return res.status(400).json({ error: 'No code provided' });
    }

    try {
        logger.log(LOG_LEVELS.INFO, 'Exchanging GitHub code for token');
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code,
            }),
        });

        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) {
            throw new Error(tokenData.error || 'Failed to get access token');
        }

        logger.log(LOG_LEVELS.INFO, 'GitHub authentication successful');
        res.json(tokenData);
    } catch (error) {
        logger.log(LOG_LEVELS.ERROR, 'GitHub authentication failed', { error: error.message });
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Enhanced endpoints with rate limiting
app.get('/api/commits', async (req, res) => {
    try {
        const commits = await readJsonFile(COMMITS_FILE);
        const votes = await readJsonFile(VOTES_FILE);

        const enrichedCommits = commits.map(commit => ({
            ...commit,
            upvotes: votes.filter(vote => vote.commitId === commit.id).length,
        }));

        enrichedCommits.sort((a, b) => b.upvotes - a.upvotes);

        const search = req.query.search?.toLowerCase();
        const filtered = search
            ? enrichedCommits.filter(c =>
                c.message.toLowerCase().includes(search) ||
                c.author.toLowerCase().includes(search)
            )
            : enrichedCommits;

        logger.log(LOG_LEVELS.INFO, 'Commits retrieved successfully', {
            total: filtered.length,
            searchTerm: search || 'none'
        });

        res.json(filtered);
    } catch (error) {
        logger.log(LOG_LEVELS.ERROR, 'Failed to retrieve commits', { error: error.message });
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/votes', rateLimiters.votes, async (req, res) => {
    const { commitId, userId } = req.body;

    if (!commitId || !userId) {
        logger.log(LOG_LEVELS.WARN, 'Invalid vote request', { commitId, userId });
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const votes = await readJsonFile(VOTES_FILE);

        if (votes.some(vote => vote.commitId === commitId && vote.userId === userId)) {
            logger.log(LOG_LEVELS.WARN, 'Duplicate vote attempt', { commitId, userId });
            return res.status(400).json({ error: 'Already voted' });
        }

        votes.push({
            commitId,
            userId,
            timestamp: new Date().toISOString(),
            ip: req.ip // Store IP for abuse detection
        });

        await writeJsonFile(VOTES_FILE, votes);
        logger.log(LOG_LEVELS.INFO, 'Vote recorded successfully', { commitId, userId });
        res.json({ success: true });
    } catch (error) {
        logger.log(LOG_LEVELS.ERROR, 'Failed to record vote', { error: error.message });
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/sync', rateLimiters.sync, async (req, res) => {
    const { token } = req.body;
    if (!token) {
        logger.log(LOG_LEVELS.WARN, 'Sync attempted without token');
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        logger.log(LOG_LEVELS.INFO, 'Starting GitHub sync');
        const commits = await fetchAllCommits(token);
        await writeJsonFile(COMMITS_FILE, commits);
        logger.log(LOG_LEVELS.INFO, 'GitHub sync completed', { commitsCount: commits.length });
        res.json({ success: true, count: commits.length });
    } catch (error) {
        logger.log(LOG_LEVELS.ERROR, 'GitHub sync failed', { error: error.message });
        res.status(500).json({ error: 'Sync failed' });
    }
});



// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.log(LOG_LEVELS.INFO, `Server started`, {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        time: new Date().toISOString()
    });
});