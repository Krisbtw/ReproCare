# AnatomyBridge imaging service (Python)

Separate process from the web app. The web app does **not call it yet**; it keeps working without it. Run it on its own, or score masks with the command line.

What is real and tested (25 pytest tests, synthetic data only):
- `POST /series/inspect`: DICOM series geometry (order by slice normal, gaps, duplicates, mixed orientation, matrix, spacing, series). Patient tags are never returned.
- `POST /metrics/score`, `python -m app.score pred ref`: Dice, Jaccard, HD95, Hausdorff, mean surface distance, volume difference, components, with physical spacing. Returns `null` when a number is unsupported.
- `GET /models`, `GET /health`: say honestly whether a model is connected.

What is not real here:
- `POST /segment/nnunet_umd` runs `nnUNetv2_predict` on weights **you** supply. **No weights are bundled, none were trained, and the prediction path has never run.** Without weights it answers 503 and returns no mask. The label map (which number is a fibroid) is never assumed; you must give it in `ANATOMYBRIDGE_NNUNET_LABELS`.

```bash
cd imaging-service
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m pytest -q
uvicorn app.main:app --port 8100     # http://localhost:8100/docs
python -m app.score pred.nii.gz ref.nii.gz --label 3
```

`openapi.json` in this folder is generated from the app (`python -c "import json;from app.main import app;print(json.dumps(app.openapi(),indent=2))"`).

Limits: uncompressed DICOM only (no compressed transfer-syntax plugins installed); uploads are read in memory and not stored; no authentication on this service, so run it on a trusted network only.
