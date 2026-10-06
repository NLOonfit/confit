// User-supplied game fixture is deliberately not part of this repository.
const {chromium}=require('playwright-core');
const {startServer}=require('../desktop/server.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const run=require('node:util').promisify(require('node:child_process').execFile);

(async()=>{
  if(!process.argv[2])throw Error('Usage: npm run test:sds -- /path/to/albert.sds');
  const fixture=path.resolve(process.argv[2]),root=path.resolve(__dirname,'..'),blender=process.env.BLENDER_PATH||'blender';
  const backend=await startServer(root,()=>blender),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mafia2-smoke-'));let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage({acceptDownloads:true,viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',err=>errors.push(err.message));
    await page.goto(backend.url);await page.locator('#files').setInputFiles(fixture);
    await page.waitForFunction(()=>/Открыт|Ошибка SDS/.test(document.getElementById('status').textContent),null,{timeout:60000});
    assert.match(await page.locator('#status').innerText(),/Открыт.*15 ресурсов.*7 текстур/);
    assert.match(await page.locator('#info').innerText(),/5\s?395/);assert.equal(await page.locator('#lod option').count(),2);
    console.log('PASS: SDS unpacked; 7 textures; LOD0 has 5395 triangles');
    for(const format of['glb','blend','fbx']){
      await page.selectOption('#format',format);const pending=page.waitForEvent('download',{timeout:180000});await page.locator('#export').click();
      await(await pending).saveAs(path.join(temp,'albert'+(format==='fbx'?'-fbx.zip':'.'+format)));console.log('PASS: export',format);
    }
    const glb=await fs.readFile(path.join(temp,'albert.glb')),json=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString());
    assert.equal(json.images.length,2,'Shared color and normal atlases should not be duplicated per material');
    assert.ok(json.materials.every(mat=>mat.pbrMetallicRoughness.baseColorTexture&&mat.normalTexture));
    console.log('PASS: color/normal texture bindings exported without duplicated images');
    await page.locator('#files').setInputFiles(path.join(temp,'albert.glb'));
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Загружено: albert.glb'));
    assert.match(await page.locator('#info').innerText(),/5\s?395/);console.log('PASS: exported GLB reimported');
    await page.locator('#files').setInputFiles(fixture);
    await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Открыт'));
    await page.selectOption('#lod','1');assert.match(await page.locator('#info').innerText(),/480/);
    await page.selectOption('#format','glb');const low=page.waitForEvent('download');await page.locator('#export').click();await(await low).saveAs(path.join(temp,'albert-lod1.glb'));
    console.log('PASS: LOD1 has 480 triangles');
    const bytes=await fs.readFile(fixture),broken=Buffer.from(bytes);broken.writeUInt32LE(20,4);
    for(const[name,buffer]of[['unsupported.sds',broken],['truncated.sds',bytes.subarray(0,400)]]){
      await page.locator('#files').setInputFiles({name,mimeType:'application/octet-stream',buffer});
      await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Ошибка SDS'));
      assert.match(await page.locator('#info').innerText(),/480/);assert.equal(await page.locator('#export').isEnabled(),true);
      console.log('PASS: rejected',name,'and retained previous model');
    }
    await page.locator('#demo').click();await page.locator('#wire').check();await page.locator('#frame').click();
    assert.match(await page.locator('#info').innerText(),/12/);assert.equal(await page.locator('#sds-controls').isVisible(),false);assert.deepEqual(errors,[]);
    const script=`import bpy,zipfile\nfrom pathlib import Path\nfrom mathutils import Vector\np=Path(${JSON.stringify(temp)})\ndef check(packed):\n meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']\n assert sum(sum(len(poly.vertices)-2 for poly in o.data.polygons) for o in meshes)==5395\n assert all(o.data.uv_layers for o in meshes)\n images=[i for i in bpy.data.images if i.type=='IMAGE' and i.size[0]>0]\n assert len(images)>=2 and all(len(i.pixels)>0 for i in images)\n if packed: assert all(i.packed_file for i in images)\n corners=[o.matrix_world@Vector(v) for o in meshes for v in o.bound_box]\n sizes=[max(v[k] for v in corners)-min(v[k] for v in corners) for k in range(3)]\n assert sizes[2]>sizes[0] and sizes[2]>sizes[1]\nbpy.ops.wm.open_mainfile(filepath=str(p/'albert.blend'))\ncheck(True)\nwith zipfile.ZipFile(p/'albert-fbx.zip') as z:\n assert any(n.startswith('textures/') for n in z.namelist())\n z.extractall(p/'fbx')\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.import_scene.fbx(filepath=str(p/'fbx/model.fbx'))\ncheck(False)\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.import_scene.gltf(filepath=str(p/'albert-lod1.glb'))\nassert sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')==480\nprint('PASS: Blender reopened BLEND, FBX and LOD1; geometry, UV, textures and orientation preserved')\n`;
    await fs.writeFile(path.join(temp,'verify.py'),script);
    const result=await run(blender,['--background','--factory-startup','--threads','2','--python-exit-code','1','--python',path.join(temp,'verify.py')],{timeout:180000,maxBuffer:8*1024*1024});
    assert.match(result.stdout,/PASS: Blender/);console.log('PASS: real Blender reopened BLEND, FBX and LOD1; geometry, UV, textures and orientation preserved');
  }finally{await browser?.close();backend.server.close();await fs.rm(temp,{recursive:true,force:true});}
})().catch(err=>{console.error(err);process.exitCode=1;});
