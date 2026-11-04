const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

dotenv.config();

const app = express();
const PORT = 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());

app.post("/api/subscriber", async (req, res) => {
  const { email } = req.body;
  res.status(200).json({ email: email });
});

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  res.status(200).json({ success: true, imageUrl: "www.test.com" });
});

app.listen(PORT, () => {
  console.log(`Test Server running on http://localhost:${PORT}`);
});
