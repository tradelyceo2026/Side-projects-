"""Package the add-on into a zip Blender can install.

    python3 tools/make_addon_zip.py

Two layouts, because Blender has two:

* default -- a *legacy add-on* zip: one top-level ``model_y/`` folder with
  ``__init__.py`` inside it.  This is what *Install from Disk* wants, and it
  works from Blender 3.6 through 5.x.
* ``--extension`` -- an *extension* zip for Blender 4.2+: the module files and
  ``blender_manifest.toml`` sit at the root of the zip, so the zip can simply be
  dragged into a Blender window.
"""

from __future__ import annotations

import argparse
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PACKAGE = os.path.join(ROOT, "model_y")

SKIP_DIRS = {"__pycache__", ".git"}
SKIP_SUFFIXES = (".pyc", ".pyo", ".blend", ".blend1")


def build(out_path: str, extension: bool = False) -> tuple[str, int, int]:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    count = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder, dirs, files in os.walk(PACKAGE):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in sorted(files):
                if name.endswith(SKIP_SUFFIXES):
                    continue
                path = os.path.join(folder, name)
                relative = os.path.relpath(path, PACKAGE)
                # extensions read the manifest from the zip root; legacy add-ons
                # want everything inside one folder named after the package
                arcname = relative if extension else os.path.join("model_y", relative)
                zf.write(path, arcname.replace(os.sep, "/"))
                count += 1
    return out_path, count, os.path.getsize(out_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    ap.add_argument("--extension", action="store_true",
                    help="build a Blender 4.2+ extension zip instead of a legacy add-on")
    args = ap.parse_args()
    default = "model_y_extension.zip" if args.extension else "model_y_addon.zip"
    path, count, size = build(args.out or os.path.join(ROOT, "dist", default),
                              args.extension)
    print(f"wrote {path} ({count} files, {size / 1024:.0f} KB)")
    if args.extension:
        print("Blender 4.2+: drag this zip into a Blender window, or use")
        print("Edit > Preferences > Get Extensions > Install from Disk.")
    else:
        print("Blender: Edit > Preferences > Add-ons > Install from Disk, pick this zip,")
        print("then enable 'Tesla Model Y 2023 Performance' and open the N panel.")


if __name__ == "__main__":
    main()
