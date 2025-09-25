# server.py
from flask import Flask, request, jsonify
from flask_cors import CORS
import pytesseract
from PIL import Image
import io

app = Flask(__name__)
CORS(app)  # <-- this fixes the CORS problem

@app.route("/ocr", methods=["POST"])
def ocr_page():
    f = request.files["page"]
    page_number = int(request.form.get("pageNumber", 1))
    image = Image.open(io.BytesIO(f.read()))

    # run OCR at word level
    data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    tokens = []
    for i in range(len(data["text"])):
        if not data["text"][i].strip():
            continue
        tokens.append({
            "page": page_number,
            "text": data["text"][i],
            "x0": data["left"][i],
            "y0": data["top"][i],
            "x1": data["left"][i] + data["width"][i],
            "y1": data["top"][i] + data["height"][i]
        })

    return jsonify({
        "tokens": tokens,
        "width": image.width,
        "height": image.height
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3001)