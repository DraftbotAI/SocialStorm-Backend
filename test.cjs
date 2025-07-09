const express = require('express');
const app = express();
app.use(express.json());

app.post('/api/generate-video', (req, res) => {
  res.json({ msg: 'Route hit!', body: req.body });
});

app.listen(3000, () => console.log('Test server running on port 3000'));
