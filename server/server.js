import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import mime from "mime";
import { fileURLToPath } from "url";
import { ocrImageBuffer } from "./ocr.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"], credentials: true }));

// Multer storage (disk) to keep memory usage predictable
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "storage");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = mime.getExtension(file.mimetype) || "bin";
    cb(null, `upload_${Date.now()}.${ext}`);
  }
});
const upload = multer({ storage });

/**
 * POST /ocr
 * Treats **file** as the unit of work. Accepts image (png/jpg).
 * Optional `page` (number) form field for client bookkeeping.
 *
 * Returns: { tokens:[{page,text,x0,y0,x1,y1}], width, height }
 */
app.post("/ocr", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')." });

    const page = Number(req.body.page || 1) || 1;

    // Only images here. If a PDF is uploaded, tell client to rasterize client-side and send page bitmap.
    if (!/^image\//.test(req.file.mimetype)) {
      // You *can* add server-side PDF rasterization later. For now, be explicit:
      fs.unlink(req.file.path, () => {});
      return res.status(415).json({
        error: "Unsupported media type. Please upload a PNG/JPEG page image.",
        hint: "For PDFs, render the current page to a canvas on the client and POST that image."
      });
    }

    const buf = fs.readFileSync(req.file.path);
    const { width, height, tokens } = await ocrImageBuffer(buf, req.file.mimetype);

    // attach page number expected by client
    const tokensWithPage = tokens.map(t => ({ page, ...t }));

    // cleanup temp
    fs.unlink(req.file.path, () => {});
    return res.json({ width, height, tokens: tokensWithPage });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(500).json({ error: "OCR failed", detail: String(err?.message || err) });
  }
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`OCR server listening on http://localhost:${PORT}`);
});