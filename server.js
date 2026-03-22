const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '2mb' }));

// Route /app to the pipeline app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint — forwards requests to Anthropic with streaming
app.post('/api/chat', async (req, res) => {
  const { apiKey, ...body } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json(err);
    }

    // Stream the response straight through to the browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }

    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n  Multi-agent pipeline running`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
