FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY train_umd.py .
RUN useradd -m -u 1000 appuser \
  && mkdir -p /var/lib/reprocare/models /var/lib/reprocare/imaging \
  && chown -R appuser:appuser /srv /var/lib/reprocare
USER appuser
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health/live')" || exit 1
# No weights are bundled. Mount a validated checkpoint to /var/lib/reprocare/models and set ANATOMYBRIDGE_UMD_WEIGHTS.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
