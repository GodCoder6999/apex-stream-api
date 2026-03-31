import express from 'express';
import cors from 'cors';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';

const app = express();
app.use(cors());

// Connection to your Redis instance
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// The Message Queue broker [cite: 19]
const scraperQueue = new Queue('ScraperFleet', { connection: redisConnection });
const queueEvents = new QueueEvents('ScraperFleet', { connection: redisConnection });

const JWT_SECRET = process.env.JWT_SECRET || 'super_secure_rsa_key_pair';

app.post('/api/v1/stream/resolve', async (req, res) => {
  const { provider_id, media_id, type, s, e } = req.query;

  try {
    const cacheKey = `stream:${provider_id}:${media_id}:${s}:${e}`;
    
    // 1. Query in-memory Redis cache [cite: 23]
    let streamUrl = await redisConnection.get(cacheKey);

    if (!streamUrl) {
      // 2. Cache miss: Construct scraping task payload and publish to queue [cite: 24]
      const job = await scraperQueue.add('extract_stream', { provider_id, media_id, type, s, e });
      
      // 3. Wait for the Scraper Fleet to complete the asynchronous task [cite: 27]
      const result = await job.waitUntilFinished(queueEvents, 15000);
      streamUrl = result.url;
    }

    // 4. Cryptographically sign the JWT protecting the infrastructure [cite: 171, 172]
    const token = jwt.sign(
      { url: streamUrl, ip: req.ip }, 
      JWT_SECRET, 
      { expiresIn: '15m' } // Strict expiration timestamp [cite: 171]
    );

    res.json({ ok: true, token: token });

  } catch (error) {
    res.status(500).json({ ok: false, error: 'Extraction failed or timed out.' });
  }
});

app.get('/api/v1/proxy/manifest', async (req, res) => {
  const { token } = req.query;

  try {
    // 1. Mathematically verify the JWT signature [cite: 175]
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // In a production environment, you would also verify decoded.ip === req.ip here [cite: 176]

    // 2. Fetch the master .m3u8 file [cite: 140]
    const upstream = await fetch(decoded.url, {
      headers: { 'User-Agent': 'Mozilla/5.0...' } // Forged headers expected by host [cite: 144]
    });

    const manifestText = await upstream.text();

    // 3. Dynamically rewrite all URIs within the file [cite: 141, 143]
    const proxyBase = `${req.protocol}://${req.get('host')}/api/v1/proxy/manifest?token=${token}&ts_url=`;
    const rewrittenManifest = manifestText.split('\n').map(line => {
      if (line.trim().startsWith('#') || !line.trim()) return line;
      // Ideally, direct clients to fetch .ts segments directly from external host's CDN to save bandwidth [cite: 151]
      return proxyBase + encodeURIComponent(new URL(line, decoded.url).href); 
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Serve with permissive CORS [cite: 166]
    res.send(rewrittenManifest);

  } catch (error) {
    res.status(403).json({ error: 'HTTP 403 Forbidden: Invalid or expired token' }); // [cite: 176]
  }
});

app.listen(3001, () => console.log('Gateway API Operational on port 3001'));
