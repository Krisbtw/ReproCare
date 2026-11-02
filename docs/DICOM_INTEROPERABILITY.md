# ReproCare / AnatomyBridge — DICOM & NIfTI Interoperability, Geometry Preservation & De-Identification

**Last Updated:** 2026-11-02  
**Primary Modules:** `src/lib/dicom/codec.ts`, `src/lib/dicom/deidentify.ts`, `src/lib/imaging/volume.ts`, `src/lib/imaging/series.ts`, `src/lib/imaging/surface.ts`, `imaging-service/app/dicom_io.py`, `imaging-service/app/dicom_deidentify.py`, `imaging-service/app/series.py`

---

## 1. Transfer Syntax Compatibility Matrix

| Transfer Syntax Name | UID | TypeScript (`src/lib/dicom/codec.ts`) | Python (`imaging-service/app/dicom_io.py`) | Pixel Depth & Rescale Support |
| :--- | :--- | :--- | :--- | :--- |
| **Implicit VR Little Endian** | `1.2.840.10008.1.2` | Native parser + decoder | `pydicom` + built-in fallback | 8/16/32-bit signed/unsigned + `RescaleSlope` (`0028,1053`) & `RescaleIntercept` (`0028,1052`) |
| **Explicit VR Little Endian** | `1.2.840.10008.1.2.1` | Native parser + decoder | `pydicom` + built-in fallback | 8/16/32-bit signed/unsigned + `RescaleSlope` & `RescaleIntercept` |
| **Deflated Explicit VR Little Endian** | `1.2.840.10008.1.2.1.99` | `node:zlib` (`inflateRawSync` / `inflateSync`) | `zlib` raw deflate | Full post-meta dataset inflation + 8/16/32-bit pixel decoding |
| **RLE Lossless** | `1.2.840.10008.1.2.5` | Native NEMA PS3.5 Annex G PackBits decoder | Native NEMA PS3.5 Annex G PackBits encoder/decoder | 8-bit and 16-bit planar byte-segment reconstruction |
| **JPEG Baseline (Process 1)** | `1.2.840.10008.1.2.4.50` | Native `Pillow` (`libjpeg`) bridge + custom decoder registry | `Pillow` (`libjpeg`) + `pylibjpeg` when installed | 8-bit grayscale (`MONOCHROME1` / `MONOCHROME2`) |
| **JPEG Lossless, Non-Hierarchical** | `1.2.840.10008.1.2.4.57` | Native `Pillow` (`libjpeg`) bridge + custom decoder registry | `Pillow` (`libjpeg`) + `pylibjpeg-libjpeg` | 8/16-bit lossless streams |
| **JPEG Lossless, SV1 (Process 14)** | `1.2.840.10008.1.2.4.70` | Native `Pillow` (`libjpeg`) bridge + custom decoder registry | `Pillow` (`libjpeg`) + `pylibjpeg-libjpeg` | 8/16-bit lossless streams |
| **JPEG 2000 Image Compression (Lossless Only)** | `1.2.840.10008.1.2.4.90` | Native `Pillow` (`openjpeg` 2.5.0) bridge + custom decoder registry | `Pillow` (`openjpeg` 2.5.0) + `pylibjpeg-openjpeg` | 8/16-bit reversible wavelet (`irreversible=False`) |
| **JPEG 2000 Image Compression** | `1.2.840.10008.1.2.4.91` | Native `Pillow` (`openjpeg` 2.5.0) bridge + custom decoder registry | `Pillow` (`openjpeg` 2.5.0) + `pylibjpeg-openjpeg` | 8/16-bit J2K/JP2 codestreams |

* **Unsupported or Corrupted Streams:** Unrecognized transfer syntaxes (e.g., `1.2.840.10008.1.2.4.999` or MPEG/HEVC video encapsulates) return `decodeStatus: "unsupported_transfer_syntax"` (TS) or raise an explicit `ValueError` (Python). Truncated pixel buffers or corrupted compressed streams return `decodeStatus: "corrupted_pixel_data"` and are **never** silently misinterpreted as raw uncompressed pixels.

---

## 2. Enhanced Multi-Frame DICOM & Series Integrity Validation

* **Multi-Frame Functional Groups (`src/lib/dicom/codec.ts`):**
  * Extracts `NumberOfFrames` (`0028,0008`), `GridFrameOffsetVector` (`3004,000C`), `SpacingBetweenSlices` (`0018,0088`), `SharedFunctionalGroupsSequence` (`5200,9229`), and `PerFrameFunctionalGroupsSequence` (`5200,9230`).
  * Parses per-frame `PlanePositionSequence` (`0020,9113` -> `ImagePositionPatient`), `PlaneOrientationSequence` (`0020,9116` -> `ImageOrientationPatient`), and `PixelMeasuresSequence` (`0028,9110` -> `PixelSpacing`, `SliceThickness`).
  * If any frame in a multi-frame object has conflicting orientation cosines or conflicting pixel spacing, or if frame positions are missing/non-monotonic, `multiFrameVolumetricReady` is set to `false` and `analyzeSeries()` blocks 3D volume reconstruction (`mixed_orientation` / `mixed_spacing`).
* **Series Reconstruction & Integrity (`src/lib/imaging/series.ts`, `imaging-service/app/series.py`):**
  * Sorts slices strictly by projection along the 3D slice-stacking normal $\hat{n} = \hat{r} \times \hat{c}$ (`ImagePositionPatient · normal`), never by filename or `InstanceNumber` alone.
  * Detects and reports `duplicate_sop_instance`, `mixed_series_uid`, `mixed_transfer_syntax`, `mixed_patient_position`, `mixed_dimensions`, `mixed_orientation`, `mixed_spacing`, `missing_slice` (integer multiples of median step), and `irregular_spacing` without silent slice interpolation.

---

## 3. End-to-End Physical DICOM LPS Geometry Preservation

All 3D volumes, masks, preprocessing steps, AI segmentations, and exported 3D meshes preserve the DICOM Patient Coordinate System (**LPS**: $+X$ Left, $+Y$ Posterior, $+Z$ Superior in $\text{mm}$):

$$\begin{bmatrix} L_{\text{mm}} \\ P_{\text{mm}} \\ S_{\text{mm}} \\ 1 \end{bmatrix} = \mathbf{A}_{4\times 4} \begin{bmatrix} v_x \\ v_y \\ v_z \\ 1 \end{bmatrix} = \begin{bmatrix} r_x \Delta x & c_x \Delta y & n_x \Delta z & O_x \\ r_y \Delta x & c_y \Delta y & n_y \Delta z & O_y \\ r_z \Delta x & c_z \Delta y & n_z \Delta z & O_z \\ 0 & 0 & 0 & 1 \end{bmatrix} \begin{bmatrix} v_x \\ v_y \\ v_z \\ 1 \end{bmatrix}$$

* `buildVoxelToPatientAffine4x4()` and `applyAffine4x4()` (`src/lib/imaging/volume.ts`) construct and apply $\mathbf{A}_{4\times 4}$.
* `toPatientSpaceBinaryStl()`, `toPatientSpaceObj()`, and `validateExportedMeshGeometry()` (`src/lib/imaging/surface.ts`) transform Marching Cubes vertices and normals into physical DICOM LPS millimetres and verify round-trip coordinate accuracy (`maxCoordinateErrorMm <= 0.01 mm`).

---

## 4. DICOM PS3.15 & NIfTI-1 De-Identification

* **DICOM PS3.15 Basic Application Level Confidentiality Profile (`src/lib/dicom/deidentify.ts`, `imaging-service/app/dicom_deidentify.py`):**
  * Scrubs/replaces standard identifying tags across Groups `0008`, `0010`, `0018`, `0020`, `0032`, `0038`, and `0040`.
  * Removes all odd-group private tags (`group % 2 === 1 && group > 0x0007 && group !== 0x7fe0`) at both the root dataset and inside nested sequences.
  * Recursively traverses nested sequences (`VR === 'SQ'`) to scrub nested PHI and remap nested UIDs while preserving `5200,9229` and `5200,9230` functional group geometry.
  * Deterministically remaps UIDs via salted HMAC-SHA256 to `2.25.<decimal>` and shifts dates by a configurable day offset.
  * Detects burned-in pixel annotation risk via header tags (`0028,0301`, `0028,0302`, Secondary Capture, Ultrasound) and top/bottom border high-contrast stroke analysis (`detectPixelBorderOverlay()`), enforcing `claimCompleteAnonymisation: false` and `manualReviewRequired: true`.
* **NIfTI-1 De-Identification (`deidentifyNiftiBytes`, `deidentify_nifti_bytes`):**
  * Scrubs `db_name`, `descrip`, `aux_file`, and `intent_name` and strips NIfTI-1 header extension blocks (`extension[0] != 0`) while keeping `qform`/`sform` 3D affine geometry and voxel intensities unchanged.
