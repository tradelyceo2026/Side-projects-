"""Install and enable the Model Y add-on from inside Blender.

Preferences has a few too many steps to get wrong, so this does all of them:

1. Open Blender, switch an area to the **Scripting** workspace.
2. **Text -> Open**, choose this file (or **Text -> New** and paste it in).
3. Put the path to ``model_y_addon.zip`` in ZIP_PATH below.
4. Press **Run Script**.

It installs the zip, enables the add-on, saves your preferences, and prints
where to find the panel.  Then press **N** over the 3D viewport and pick the
**Model Y** tab.
"""

import os

import bpy

# ---------------------------------------------------------------------------
# EDIT THIS: the path to the zip you downloaded.
#   Windows: r"C:\\Users\\you\\Downloads\\model_y_addon.zip"
#   macOS:   "/Users/you/Downloads/model_y_addon.zip"
#   Linux:   "/home/you/Downloads/model_y_addon.zip"
# Leave it empty to search your Downloads and Desktop folders automatically.
# ---------------------------------------------------------------------------
ZIP_PATH = ""

MODULE = "model_y"
CANDIDATE_NAMES = ("model_y_addon.zip", "model_y_extension.zip")


def find_zip() -> str:
    if ZIP_PATH:
        return os.path.expanduser(ZIP_PATH)
    home = os.path.expanduser("~")
    for folder in (os.path.join(home, "Downloads"), os.path.join(home, "Desktop"), home):
        for name in CANDIDATE_NAMES:
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                return path
    return ""


def install() -> bool:
    path = find_zip()
    if not path:
        print("Could not find model_y_addon.zip -- set ZIP_PATH at the top of "
              "this script to wherever you saved it.")
        return False
    if not os.path.isfile(path):
        print("No such file: %s" % path)
        return False

    print("installing", path)
    bpy.ops.preferences.addon_install(filepath=path, overwrite=True)
    try:
        bpy.ops.preferences.addon_enable(module=MODULE)
    except RuntimeError as exc:
        # installed as an extension rather than a legacy add-on: the module is
        # namespaced under the repository it landed in
        for repo in ("user_default", "blender_org"):
            try:
                bpy.ops.preferences.addon_enable(module="bl_ext.%s.%s" % (repo, MODULE))
                break
            except RuntimeError:
                continue
        else:
            print("installed, but could not enable it automatically:", exc)
            return False
    bpy.ops.wm.save_userpref()

    print()
    print("Done. In the 3D viewport:")
    print("  1. move the mouse over the viewport and press N (or View > Sidebar)")
    print("  2. click the 'Model Y' tab down the right-hand edge")
    print("  3. press 'Build Model Y'")
    return True


if __name__ == "__main__":
    install()
