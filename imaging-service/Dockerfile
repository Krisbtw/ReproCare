FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /srv
USER appuser
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health')" || exit 1
# No weights are bundled. Mount an nnU-Net results folder and set the ANATOMYBRIDGE_NNUNET_* variables to connect one.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
