# server.py
from flask import Flask, request, jsonify
from PIL import Image
import pytesseract
import io

app = Flask(__name__)

@app.route("/ocr", methods=["POST"])
def ocr():
    if "page" not in request.files:
        return jsonify({"error": "missing 'page' file"}), 422
    
    file = request.files["page"]
    try:
        image = Image.open(file.stream).convert("RGB")
    except Exception as e:
        return jsonify({"error": f"failed to read image: {e}"}), 422
    
    width, height = image.size
    
    # Run Tesseract OCR with bounding boxes
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    tokens = []
    for i in range(len(data["text"])):
        txt = data["text"][i].strip()
        if not txt: 
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        tokens.append({
            "page": int(request.form.get("pageNumber", 1)),
            "text": txt,
            "x0": x,
            "y0": y,
            "x1": x + w,
            "y1": y + h
        })
    
    return jsonify({
        "tokens": tokens,
        "width": width,
        "height": height
    })

if __name__ == "__main__":
    app.run(port=3001, debug=True)