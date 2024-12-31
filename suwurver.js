const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// GitHub OAuth settings
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    console.error('GitHub OAuth credentials are not set.');
    process.exit(1);
}

// File paths
const PULLS_FILE = path.resolve('pull_requests.json');
const VOTES_FILE = path.resolve('votes.json');
const LOGS_DIR = path.resolve('logs');

// Ensure the /logs directory exists
fs.mkdir(LOGS_DIR, { recursive: true }).catch(console.error);

// Middleware for logging requests
const logs = [];
app.use((req, res, next) => {
    const logEntry = `${new Date().toISOString()} - ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}\n`;
    logs.push(logEntry);
    console.log(logEntry);
    next();
});

// Save logs to file every 10 minutes
setInterval(async () => {
    if (logs.length > 0) {
        const logFile = path.join(LOGS_DIR, `log_${Date.now()}.txt`);
        try {
            await fs.writeFile(logFile, logs.join(''));
            logs.length = 0; // Clear logs after saving
            console.log(`Logs saved to ${logFile}`);
        } catch (error) {
            console.error('Error saving logs:', error);
        }
    }
}, 10 * 60 * 1000);

// Helper to read JSON files
async function readJsonFile(filename, defaultValue = []) {
    try {
        const data = await fs.readFile(filename, 'utf8');
        return JSON.parse(data);
    } catch {
        await fs.writeFile(filename, JSON.stringify(defaultValue));
        return defaultValue;
    }
}

// Helper to write JSON files
async function writeJsonFile(filename, data) {
    await fs.writeFile(filename, JSON.stringify(data, null, 2));
}

// Helper function to fetch all pull requests from GitHub
async function fetchAllPullRequests(token) {
    const pullRequests = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
        const response = await fetch(
            `https://api.github.com/repos/DishpitDev/Slopify/pulls?state=all&per_page=100&page=${page}`, {
                headers: {
                    Authorization: `token ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                },
            });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.statusText}`);
        }

        const pagePRs = await response.json();
        pullRequests.push(...pagePRs);

        // Check if there's another page
        const linkHeader = response.headers.get('Link');
        hasNextPage = linkHeader && linkHeader.includes('rel="next"');
        page++;
    }

    // Map the pull requests to the desired format
    return pullRequests.map(pr => ({
        id: pr.number.toString(),
        message: pr.title,
        description: pr.body || '',
        author: pr.user.login,
        date: pr.created_at,
        link: pr.html_url,
        state: pr.state,
        merged: pr.merged_at !== null,
        mergedAt: pr.merged_at
    }));
}

// GitHub OAuth endpoint
app.get('/auth/github', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).json({ error: 'No code provided' });
    }

    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
            },
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

        res.json(tokenData);
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Get pull requests
app.get('/api/pulls', async (req, res) => {
    try {
        const pulls = await readJsonFile(PULLS_FILE);
        const votes = await readJsonFile(VOTES_FILE);

        const enrichedPulls = pulls.map(pull => ({
            ...pull,
            upvotes: votes.filter(vote => vote.pullId === pull.id).length,
        }));

        enrichedPulls.sort((a, b) => b.upvotes - a.upvotes);

        const search = req.query.search?.toLowerCase();
        const filtered = search
            ? enrichedPulls.filter(p =>
                p.message.toLowerCase().includes(search) ||
                p.author.toLowerCase().includes(search) ||
                (p.description && p.description.toLowerCase().includes(search))
            )
            : enrichedPulls;

        res.json(filtered);
    } catch (error) {
        console.error('Error getting pull requests:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Handle votes
app.post('/api/votes', async (req, res) => {
    const { pullId, userId } = req.body;

    try {
        const votes = await readJsonFile(VOTES_FILE);

        if (votes.some(vote => vote.pullId === pullId && vote.userId === userId)) {
            return res.status(400).json({ error: 'Already voted' });
        }

        votes.push({
            pullId,
            userId,
            timestamp: new Date().toISOString(),
        });

        await writeJsonFile(VOTES_FILE, votes);
        res.json({ success: true });
    } catch (error) {
        console.error('Error handling vote:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Sync pull requests from GitHub
app.post('/api/sync', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const pulls = await fetchAllPullRequests(token);
        await writeJsonFile(PULLS_FILE, pulls);
        res.json({ success: true, count: pulls.length });
    } catch (error) {
        console.error('Error syncing pull requests:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the leaderboard.html file on the "/leaderboard" route
app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

// Root route
app.get('/', (req, res) => {
    res.send(`
        <h1>Pull Request Voting Server</h1>
        <p>Server is running successfully!</p>
    `);
});

// OAuth callback route
app.get('/oauth/callback', (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send('Missing authorization code');
    }
    res.send('Authentication successful!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});