# Pinned to a Debian release so a rebuild next year gets the same system packages.
FROM python:3.11-slim-trixie

WORKDIR /app

# tesseract + ghostscript power OCR and PDF/A (with every OCR language the site offers: English pairs
# plus 12 Indian languages); LibreOffice converts Office files; nodejs runs the in-browser tool tests.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential tesseract-ocr tesseract-ocr-eng ghostscript nodejs \
    tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa \
    tesseract-ocr-hin tesseract-ocr-mar tesseract-ocr-ben tesseract-ocr-tam tesseract-ocr-tel tesseract-ocr-guj \
    tesseract-ocr-kan tesseract-ocr-mal tesseract-ocr-pan tesseract-ocr-urd tesseract-ocr-ori tesseract-ocr-san \
    libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run as an ordinary user: if a malicious file ever broke out of a converter, it could not
# change the app, the system or other containers' files. Only data/ (feedback) is writable.
RUN useradd --system --uid 10001 --home-dir /home/app --create-home app \
    && mkdir -p /app/data && chown app:app /app/data
USER app

ENV PYTHONDONTWRITEBYTECODE=1 \
    ULTRAPDF_DATA_DIR=/app/data

EXPOSE 8000

# Hosts such as Render, Railway, Fly.io, Koyeb and Google Cloud Run tell the app which port to
# listen on through $PORT; everywhere else it is 8000.
ENV PORT=8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8000'), timeout=4)"

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --no-server-header --limit-concurrency 200 --timeout-keep-alive 5"]
