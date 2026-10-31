# Imaging pipeline (what exists, what it proves, what it does not)

All modules are pure TypeScript with no DOM or parser dependency, so they run in the browser or in Node tests. All are covered by tests in `src/lib/imaging/pipeline.test.ts` and `src/lib/dicom/pixels.test.ts`.

## Flow

```
DICOM files → (dicom-parser) headers + raw pixel bytes
  → decodePixels()            8/16-bit, signed/unsigned, endianness, rescale slope/intercept
  → geometryFromMetadata()    per-slice position, orientation, spacing
  → analyzeSeries()           order along slice normal; report gaps, duplicates, mixed orientation/matrix/series
  → buildVolume()             refuses unless the report is volume-ready; x = column, y = row, z = slice
  → segmentFromSeed()         clinician-placed seed + intensity window; closing; largest component; leakage guard
  → surfaceFromMask()         pad, 3×3×3 blur, marching tetrahedra at 0.5
  → taubinSmooth()            optional refinement
  → meshQuality() / toBinaryStl() / toObj()
  → measureMask()             volume, centroid, principal-axis extents → feeds ReproTrace `axesMm`
  → dice() / surfaceDistances() / relativeVolumeDifferencePct()   only when a reference mask exists
```

## Design decisions

- **Missing slices are reported, not repaired.** A series with a gap is not stacked. Interpolating invented slices would put made-up pixels under a measurement.
- **Spatial order beats instance number.** If they disagree, spatial position is used and a warning is added.
- **Thickness ≠ spacing is a warning.** Public fibroid data uses 4.0–7.5 mm slice thickness with 4.4–7.5 mm spacing (Female-RHINO paper, Table I, describing the UMD protocol), so overlap or gaps by protocol are normal and must be visible, not hidden.
- **Segmentation here is classical.** `segmentFromSeed` returns `isLearnedModel: false` and its own step list. It has no anatomical knowledge: whatever the seed sits in is what is grown. It cannot tell a fibroid from fat of similar intensity. It is a real, inspectable workflow for the demonstration, not a substitute for nnU-Net/MONAI.
- **Marching tetrahedra, not a 256-case Marching Cubes table.** The Kuhn six-tetrahedra split is face-consistent between neighbouring cells, so closed objects are watertight without ambiguity patches. Meshes are in image-index millimetres, not yet transformed to patient coordinates.
- **Metrics return `null` instead of a number** for empty masks or mismatched grids. Surface distances compare boundary-voxel centres, so they carry up to about one voxel of quantisation error.

## Measured test results (synthetic phantoms only)

Run in this workspace with `node --experimental-strip-types --test`:

| Check | Result |
|---|---|
| Ellipsoid 20×15×12 mm radii on a 1×1×1.5 mm grid, mesh | watertight, Euler characteristic 2, 0 degenerate triangles, 1 component |
| Mesh volume vs analytic | −1.5% |
| Mesh area vs Knud Thomsen approximation | −0.2% |
| Noisy phantom (contrast 90, noise ±8), region growing Dice vs truth | 1.000 (trivially separable; not evidence of real-world accuracy) |
| Harder phantom (partial-volume blur, noise ±25 on contrast 90) Dice vs truth | 0.951 (5863 vs 6048 true voxels) |
| Mask shifted 4 mm: Hausdorff / HD95 | 4.0 / 4.0 mm |
| Principal-axis extents of a 40×24×16 mm ellipsoid | 39.7, 23.5, 16.6 mm |
| Taubin smoothing volume change | < 6%, still watertight |
| Binary STL size | exactly 84 + 50 × triangles bytes |

These numbers describe the code on synthetic shapes. They are **not** clinical accuracy, not a Dice score on MRI, and not a validation of any anatomy.

## Not done yet

- Browser upload of a multi-file series wired to these modules (UI). The libraries are ready; no screen calls them.
- Compressed transfer syntaxes (JPEG, JPEG-2000, RLE) are not decoded.
- Resampling to isotropic voxels and registration between studies.
- Any trained model. nnU-Net / MONAI / TotalSegmentator remain "not connected".
- Patient-coordinate transform of meshes (the orientation vectors are validated and kept in the series report but not yet applied to the mesh).
