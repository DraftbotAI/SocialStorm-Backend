const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend')));

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'This is a test endpoint working!' });
});

// Placeholder for video generation endpoint
app.post('/api/generate-video', (req, res) => {
  // TODO: Add your video generation logic here
  res.json({ message: 'Video generation endpoint hit', data: req.body });
});

// For any other routes, serve index.html (for SPA behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>title</title>
</head>
<body>
    
</body>
</html>