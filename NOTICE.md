# Third-party notices — Reality Engine

The original code in this repository is MIT licensed (see `LICENSE`).
**The MIT grant does not extend to the vendored files below**, each of which
carries its own licence. Everything here is redistributed unmodified.

If you fork this repository, these obligations travel with it.

---

## Vendored libraries

| Path | Project | Licence |
|---|---|---|
| `vendor/tfjs/tf.min.js` | TensorFlow.js | Apache-2.0 |
| `vendor/tfjs/coco-ssd.min.js` | TensorFlow.js Models (COCO-SSD) | Apache-2.0 |
| `vendor/tfjs/pose-detection.min.js` | TensorFlow.js Models (pose-detection) | Apache-2.0 |

## Vendored model weights

Model weights are licensed separately from the inference code that loads them.
Both are Apache-2.0 here.

| Path | Model | Licence |
|---|---|---|
| `vendor/models/coco-ssd-lite/` | COCO-SSD Lite (object detection) | Apache-2.0 |
| `vendor/models/movenet-lightning/` | MoveNet Lightning (pose estimation) | Apache-2.0 |

## Vendored data

These are **aggregates computed offline from public sources**, not
redistributions of the source datasets. The raw data and the build scripts are
not in this repository.

| Path | Derived from |
|---|---|
| `data/football/`, `data/football-reference.json` | nflverse play-by-play and participation data (2023-2025) |
| `data/baseball/` | MLB Statcast pitch-level data (2024) |
| `data/movements.json`, `data/repairs.json`, `data/automotive*.json`, `data/chemistry-safety.json` | Authored for this project |
| `knowledge-packs/` | Authored for this project |

⚠️ **Open item:** the terms attached to the *underlying* nflverse and Statcast
data have not been formally reviewed. Both are publicly available and this
repository ships only derived aggregates, but if this project is ever
distributed more widely, confirm the source terms before relying on that
distinction.

---

## Not vendored, but worth recording

The Brilliant Labs SDK (`brilliantlabsAR/brilliant_sdk`, BSD-3-Clause) and the
Halo firmware (`brilliantlabsAR/halo-firmware`) are referenced by the planning
documents but **no code from either is currently in this repository**. Note that
the firmware repository is deliberately **not** uniformly Apache-2.0: Brilliant's
own code is Apache-2.0, but the vendored Alif Semiconductor SDK portions carry a
licence restricting use to Alif silicon and forbidding copyleft relicensing. If
anything from it is ever vendored here, record it above and read the per-file
headers first.
