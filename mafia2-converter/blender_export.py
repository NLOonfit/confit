"""Runs inside Blender's Python. Exports a static GLB scene."""
import sys
from pathlib import Path
import zipfile
import bpy

source, destination, target = sys.argv[sys.argv.index('--') + 1:]
folder = Path(destination)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
if not any(obj.type == 'MESH' for obj in bpy.context.scene.objects):
    raise RuntimeError('No meshes were imported')
if target == 'blend':
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / 'model.blend'))
elif target == 'fbx':
    textures = folder / 'textures'
    textures.mkdir(exist_ok=True)
    for index, image in enumerate(bpy.data.images):
        if image.type != 'IMAGE' or image.size[0] == 0:
            continue
        _ = image.pixels[0]  # Packed glTF images load lazily.
        image.filepath_raw = str(textures / f'texture_{index:03}.png')
        image.file_format = 'PNG'
        image.save()
        if image.packed_file:
            image.unpack(method='REMOVE')
    bpy.ops.export_scene.fbx(filepath=str(folder / 'model.fbx'), path_mode='COPY', embed_textures=True, bake_anim=False, use_selection=False, add_leaf_bones=False)
    with zipfile.ZipFile(folder / 'model-fbx.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(folder / 'model.fbx', 'model.fbx')
        for texture in textures.glob('*'):
            archive.write(texture, f'textures/{texture.name}')
else:
    raise ValueError('Unsupported target')
