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
const COMMITS_FILE = path.resolve('commits.json');
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


//helper function to fetch all commits from GitHub
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
                Accept: 'application/json',  // We're expecting a JSON response
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

// Get commits
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

        res.json(filtered);
    } catch (error) {
        console.error('Error getting commits:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Handle votes
app.post('/api/votes', async (req, res) => {
    const { commitId, userId } = req.body;

    try {
        const votes = await readJsonFile(VOTES_FILE);

        if (votes.some(vote => vote.commitId === commitId && vote.userId === userId)) {
            return res.status(400).json({ error: 'Already voted' });
        }

        votes.push({
            commitId,
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

// Sync commits from GitHub
app.post('/api/sync', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const commits = await fetchAllCommits(token);
        await writeJsonFile(COMMITS_FILE, commits);
        res.json({ success: true, count: commits.length });
    } catch (error) {
        console.error('Error syncing commits:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});


// Simple endpoint
// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the leaderboard.html file on the "/leaderboard" route
app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

// A simple root route
app.get('/', (req, res) => {
    res.send(`
        <h1>uwu hewwo fwom the sewvew mistew ~!!</h1>
        <img src="https://i1.sndcdn.com/artworks-3Fn0oBkY1yGb9wvN-Jr0xwA-t500x500.jpg">
    `);
});

app.get('/oauth/callback', (req, res) => {
    const { code } = req.query; // Retrieve the authorization code
    if (!code) {
        return res.status(400).send('Missing authorization code');
    }
    // Process the code (e.g., exchange it for an access token)
    res.send('Authentication successful!');
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
