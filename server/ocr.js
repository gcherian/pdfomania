// tesseract.js wrapper: returns word-level tokens with pixel boxes
import { createWorker } from "tesseract.js";

/**
 * OCR an image buffer.
 * @param {Buffer} buf - image bytes (png/jpg)
 * @param {string} mime - image mime
 * @returns {Promise<{width:number,height:number,tokens:Array<{text:string,x0:number,y0:number,x1:number,y1:number}>}>}
 */
export async function ocrImageBuffer(buf, mime = "image/png") {
  const worker = await createWorker("eng", 1, {
    // You can set logger: m => console.log(m) for progress if needed
  });

  try {
    const { data } = await worker.recognize(buf);
    const tokens = (data.words || []).map(w => ({
      text: String(w.text || "").trim(),
      x0: w.bbox.x0,
      y0: w.bbox.y0,
      x1: w.bbox.x1,
      y1: w.bbox.y1
    })).filter(t => t.text);

    // tesseract.js gives image size as data.imageSize (if available)
    const width  = data?.imageSize?.width  ?? Math.max(...tokens.map(t => t.x1), 0);
    const height = data?.imageSize?.height ?? Math.max(...tokens.map(t => t.y1), 0);

    return { width, height, tokens };
  } finally {
    await worker.terminate();
  }
}