import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import { createWorker } from "@tesseract.js/node";

const app = express();
app.use(cors());
app.use(fileUpload({ limits: { fileSize: 25 * 1024 * 1024 } }));

// Spin up one worker (simple + fast enough for demos)
const worker = await createWorker("eng");

app.get("/health", (_req, res) => res.json({ ok: true }));

// POST /ocr  (form-data: page=<png|jpg>, pageNumber=<1-based>)
app.post("/ocr", async (req, res) => {
  try {
    const file = req.files?.page;
    if (!file) return res.status(400).json({ error: "missing 'page' file" });

    const pg = Number(req.body.pageNumber || 1);
    const { data } = await worker.recognize(file.data, { tessedit_pageseg_mode: 6 });

    // Map Tesseract words -> TokenBox[]
    const tokens = (data.words || [])
      .filter(w => (w.text || "").trim())
      .map(w => ({
        page: pg,
        text: w.text,
        x0: w.bbox.x0, y0: w.bbox.y0,
        x1: w.bbox.x1, y1: w.bbox.y1
      }));

    res.json({ tokens, width: data.imageSize?.width, height: data.imageSize?.height });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`OCR server on http://localhost:${PORT}`));