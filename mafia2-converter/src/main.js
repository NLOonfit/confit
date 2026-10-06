import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {MTLLoader} from 'three/addons/loaders/MTLLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DDSLoader} from 'three/addons/loaders/DDSLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import * as WebGLTextureUtils from 'three/addons/utils/WebGLTextureUtils.js';
import {unpackSds,readSdsModel} from './sds.js';
import './style.css';

const $=id=>document.getElementById(id),view=$('viewport');
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;view.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#15191e');
const camera=new THREE.PerspectiveCamera(45,1,.01,10000);camera.position.set(5,3,5);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xe6f0ff,0x53505b,2.5));
const sun=new THREE.DirectionalLight(0xffead3,3);sun.position.set(4,8,5);scene.add(sun);
const grid=new THREE.GridHelper(20,20,0x59616b,0x303943);scene.add(grid);
let model,modelName='model',busy=false,sdsState;
const status=message=>{$('status').textContent=message;};

if(window.desktop){
  $('blender').hidden=false;
  $('blender').addEventListener('click',async()=>{try{const name=await window.desktop.chooseBlender();if(name)status(`Выбран Blender: ${name}`);}catch(err){status(`Ошибка выбора Blender: ${err.message}`);}});
}
new ResizeObserver(()=>{
  renderer.setSize(view.clientWidth,view.clientHeight);camera.aspect=view.clientWidth/view.clientHeight;camera.updateProjectionMatrix();
}).observe(view);
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
function lock(value){
  busy=value;for(const id of['files','folder','demo','wire'])$(id).disabled=value;
  for(const control of document.querySelectorAll('#sds-controls select,#format'))control.disabled=value;
  $('export').disabled=value||!model;
}
function dispose(object){
  const geometries=new Set(),materials=new Set(),textures=new Set();
  object.traverse(node=>{if(node.geometry)geometries.add(node.geometry);for(const mat of[node.material].flat().filter(Boolean)){materials.add(mat);for(const value of Object.values(mat))if(value?.isTexture)textures.add(value);}});
  geometries.forEach(x=>x.dispose());materials.forEach(x=>x.dispose());textures.forEach(x=>x.dispose());
}
function frame(){
  if(!model)return;const box=new THREE.Box3().setFromObject(model);if(box.isEmpty())return;
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),radius=Math.max(size.length()/2,.01);
  const angle=Math.min(camera.fov*Math.PI/360,Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect)),distance=radius/Math.sin(angle)*1.2;
  controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(model.userData.sds?-1:1,.7,1).normalize().multiplyScalar(distance));
  camera.near=Math.max(radius/1000,.0001);camera.far=Math.max(distance*20,100);camera.updateProjectionMatrix();controls.update();
  grid.position.y=box.min.y;grid.scale.setScalar(Math.max(size.x,size.y,size.z,.01)/10);
}
function wireframe(){model?.traverse(node=>{for(const mat of[node.material].flat().filter(Boolean))mat.wireframe=$('wire').checked;});}
function show(object,name,preserveSds=false){
  const box=new THREE.Box3().setFromObject(object);if(box.isEmpty()||!Number.isFinite(box.min.x+box.max.x))throw Error('Модель не содержит корректной геометрии.');
  if(model){scene.remove(model);dispose(model);}model=object;modelName=name.replace(/\.[^.]+$/,'');
  if(!preserveSds){sdsState?.textureList.forEach(item=>item.texture.dispose());sdsState=null;$('sds-controls').hidden=true;}
  scene.add(model);let meshes=0,triangles=0;
  model.traverse(node=>{if(node.isMesh){meshes++;triangles+=(node.geometry.index?.count??node.geometry.attributes.position?.count??0)/3;}});
  $('info').textContent=`${name} · ${meshes} мешей · ${Math.floor(triangles).toLocaleString('ru')} треугольников`;
  $('empty').hidden=true;wireframe();frame();$('export').disabled=busy;
}
function normalize(path){let decoded=path;try{decoded=decodeURIComponent(path);}catch{}return decoded.replaceAll('\\','/').replace(/^\.\//,'').toLowerCase();}

async function loadFiles(list){
  if(busy||!list.length)return;const files=Array.from(list),archives=files.filter(f=>/\.sds$/i.test(f.name));
  if(archives.length){
    if(archives.length!==1||files.length!==1){status('Выберите один SDS отдельно от остальных файлов.');return;}
    lock(true);status('Распаковка SDS и чтение геометрии…');
    try{await openSds(readSdsModel(await unpackSds(await archives[0].arrayBuffer())),archives[0].name);}catch(err){status(`Ошибка SDS: ${err.message}`);}finally{lock(false);}return;
  }
  const candidates=files.filter(f=>/\.(obj|glb|gltf)$/i.test(f.name));
  if(candidates.length!==1){status(candidates.length>1?'Выберите одну модель и её ресурсы.':'Нужен SDS, OBJ, GLB или glTF.');return;}
  lock(true);status('Чтение модели и текстур…');
  const selected=candidates[0],selectedPath=normalize(selected.webkitRelativePath||selected.name),base=selectedPath.includes('/')?selectedPath.slice(0,selectedPath.lastIndexOf('/')+1):'';
  const manager=new THREE.LoadingManager(),urls=new Map(),byPath=new Map();let loadingError;
  files.forEach(file=>byPath.set(normalize(file.webkitRelativePath||file.name),file));
  function findFile(path){const key=normalize(path);if(byPath.has(key))return byPath.get(key);if(byPath.has(base+key))return byPath.get(base+key);const matches=files.filter(f=>normalize(f.name)===key.split('/').pop());return matches.length===1?matches[0]:undefined;}
  manager.setURLModifier(path=>{if(/^(blob:|data:)/i.test(path))return path;const file=findFile(path);if(!file)throw Error(`Не найден локальный ресурс: ${path}`);if(!urls.has(file))urls.set(file,URL.createObjectURL(file));return urls.get(file);});
  manager.addHandler(/\.dds$/i,new DDSLoader(manager));manager.onError=()=>{loadingError='Не удалось загрузить локальную текстуру или ресурс.';};
  try{
    let object,animations=0;
    if(/\.obj$/i.test(selected.name)){
      const source=await selected.text(),obj=new OBJLoader(manager),libraries=[...source.matchAll(/^\s*mtllib\s+(.+)$/gm)].map(m=>m[1].trim());
      if(libraries.length>1)throw Error('Несколько MTL в одном OBJ пока не поддерживаются.');
      if(libraries.length){
        const file=findFile(libraries[0]);if(!file)throw Error(`Не найден MTL: ${libraries[0]}`);
        const materialPath=normalize(file.webkitRelativePath||file.name),directory=materialPath.includes('/')?materialPath.slice(0,materialPath.lastIndexOf('/')+1):base;
        const materials=new MTLLoader(manager).parse(await file.text(),directory);
        await new Promise((resolve,reject)=>{manager.onLoad=resolve;try{materials.preload();if(!Object.values(materials.materials).some(mat=>Object.values(mat).some(value=>value?.isTexture)))resolve();}catch(err){reject(err);}});
        if(loadingError)throw Error(loadingError);obj.setMaterials(materials);
      }
      object=obj.parse(source);
    }else{
      const source=/\.glb$/i.test(selected.name)?await selected.arrayBuffer():await selected.text(),gltf=await new GLTFLoader(manager).parseAsync(source,base);object=gltf.scene;animations=gltf.animations.length;
    }
    if(loadingError){dispose(object);throw Error(loadingError);}show(object,selected.name);
    status(`Загружено: ${selected.name}.${animations?' Анимации не воспроизводятся и не экспортируются.':''}`);
  }catch(err){status(`Ошибка импорта: ${err.message}`);}finally{urls.forEach(url=>URL.revokeObjectURL(url));lock(false);}
}

async function openSds(parsed,filename){
  const textureList=[];
  try{
    for(const item of parsed.textures){
      const url=URL.createObjectURL(new Blob([item.bytes],{type:'image/vnd-ms.dds'}));
      try{const texture=await new DDSLoader().loadAsync(url);texture.name=item.name;textureList.push({...item,texture});}finally{URL.revokeObjectURL(url);}
    }
    const previous=sdsState,state={parsed,textureList,filename,lod:0,up:parsed.hasSkeleton?'x':'z',bindings:new Map()};
    renderSds(state,0);previous?.textureList.forEach(item=>item.texture.dispose());sdsState=state;
    $('lod').replaceChildren();parsed.lods.forEach((lod,i)=>{const option=document.createElement('option');option.value=i;option.textContent=`LOD ${i} · ${lod.vertices} вершин · ${lod.indices.length/3} треугольников`;$('lod').appendChild(option);});
    $('up-axis').value=state.up;$('sds-controls').hidden=false;
    status(`Открыт ${filename}: ${parsed.resourceCount} ресурсов, ${parsed.lods.length} LOD, ${textureList.length} текстур. Экспорт статический. Привязки атласа и нормалей можно изменить.`);
  }catch(err){textureList.forEach(item=>item.texture.dispose());throw err;}
}
function renderSds(state,lodIndex){
  const lod=state.parsed.lods[lodIndex],geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(lod.positions,3));geometry.setIndex(new THREE.BufferAttribute(lod.indices,1));
  if(lod.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(lod.normals,3));else geometry.computeVertexNormals();
  if(lod.uvs)geometry.setAttribute('uv',new THREE.BufferAttribute(lod.uvs,2));
  const materials=[],materialByHash=new Map(),cache=new Map();
  const diffuse=state.textureList.find(item=>new RegExp(lodIndex?'dlod\\.dds$':'d\\.dds$','i').test(item.name))||state.textureList.find(item=>/d\.dds$/i.test(item.name));
  const normal=lodIndex===0?state.textureList.find(item=>/n\.dds$/i.test(item.name)):undefined;
  $('materials').replaceChildren();
  function textureFor(index,color){
    if(index===null)return null;const item=state.textureList[index],key=`${item.hash}:${color}`;
    if(!cache.has(key)){const texture=item.texture.clone();texture.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;texture.needsUpdate=true;cache.set(key,texture);}return cache.get(key);
  }
  function release(texture){
    if(!texture||materials.some(mat=>mat.map===texture||mat.normalMap===texture))return;
    texture.dispose();for(const[key,value]of cache)if(value===texture)cache.delete(key);
  }
  for(const group of lod.groups){
    let index=materialByHash.get(group.material);
    if(index===undefined){
      index=materials.length;materialByHash.set(group.material,index);const bindingKey=`${lodIndex}:${group.material}`;
      const binding=state.bindings.get(bindingKey)||{diffuse:diffuse?state.textureList.indexOf(diffuse):null,normal:normal?state.textureList.indexOf(normal):null};state.bindings.set(bindingKey,binding);
      const material=new THREE.MeshStandardMaterial({map:textureFor(binding.diffuse,true),normalMap:textureFor(binding.normal,false),roughness:.8});material.name=`MafiaMaterial_${group.material}`;materials.push(material);
      const label=document.createElement('label');label.className='hint';label.textContent=`Материал ${index+1} · ${group.material}`;$('materials').appendChild(label);
      for(const[slot,key,color,title]of[['map','diffuse',true,'Цветовая текстура'],['normalMap','normal',false,'Карта нормалей']]){
        const caption=document.createElement('label');caption.className='hint';caption.textContent=title;
        const select=document.createElement('select'),none=document.createElement('option');none.value='';none.textContent='Без текстуры';select.appendChild(none);
        state.textureList.forEach((item,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=item.name;select.appendChild(option);});select.value=binding[key]===null?'':String(binding[key]);
        select.addEventListener('change',()=>{const old=material[slot];binding[key]=select.value===''?null:Number(select.value);material[slot]=textureFor(binding[key],color);material.needsUpdate=true;release(old);});
        $('materials').append(caption,select);
      }
    }
    geometry.addGroup(group.start,group.count,index);
  }
  const object=new THREE.Group();object.name=state.filename;object.userData.sds=true;
  const mesh=new THREE.Mesh(geometry,materials);mesh.name=lod.name;object.add(mesh);
  if(state.up==='x')object.rotation.z=Math.PI/2;else if(state.up==='z')object.rotation.x=-Math.PI/2;
  show(object,state.filename,true);state.lod=lodIndex;
}

$('files').addEventListener('change',event=>{loadFiles(event.target.files);event.target.value='';});
$('folder').addEventListener('change',event=>{loadFiles(event.target.files);event.target.value='';});
$('wire').addEventListener('change',wireframe);$('frame').addEventListener('click',frame);
$('lod').addEventListener('change',()=>{if(sdsState&&!busy){renderSds(sdsState,Number($('lod').value));status(`Выбран LOD ${sdsState.lod}. Экспортируется этот LOD.`);}});
$('up-axis').addEventListener('change',()=>{if(!sdsState||busy)return;sdsState.up=$('up-axis').value;model.rotation.set(0,0,0);if(sdsState.up==='x')model.rotation.z=Math.PI/2;else if(sdsState.up==='z')model.rotation.x=-Math.PI/2;frame();status(`Ось вверх: ${sdsState.up.toUpperCase()}. Ориентация включается в экспорт.`);});
$('demo').addEventListener('click',()=>{
  if(busy)return;const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#bfa077';ctx.fillRect(0,0,64,64);ctx.fillStyle='#544536';ctx.fillRect(0,0,32,32);ctx.fillRect(32,32,32,32);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;const group=new THREE.Group(),cube=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshStandardMaterial({map:texture,roughness:.7}));cube.position.y=1;group.add(cube);show(group,'demo');status('Демонстрационная модель. Это не ресурс Mafia II.');
});
$('export').addEventListener('click',async()=>{
  if(!model||busy)return;lock(true);status('Экспорт геометрии, материалов и изображений…');const original=new Map(),readableTextures=[];
  model.traverse(node=>{for(const mat of[node.material].flat().filter(Boolean)){if(!original.has(mat))original.set(mat,mat.wireframe);mat.wireframe=false;}});
  try{
    const exporter=new GLTFExporter(),decompressed=new WeakMap();
    exporter.setTextureUtils({decompress(texture,maxSize){if(!decompressed.has(texture)){const readable=WebGLTextureUtils.decompress(texture,maxSize);decompressed.set(texture,readable);readableTextures.push(readable);}return decompressed.get(texture);}});
    const output=await exporter.parseAsync(model,{binary:true,onlyVisible:false});
    const format=$('format').value;let blob=new Blob([output],{type:'model/gltf-binary'});
    if(format!=='glb'){
      const response=await fetch(`/api/export/${format}`,{method:'POST',headers:{'Content-Type':'model/gltf-binary','X-M2-Request':'export'},body:blob});
      if(!response.ok){const detail=await response.json().catch(()=>({}));throw Error(detail.error||'Сервис Blender недоступен. Запустите настольное приложение и выберите Blender.');}blob=await response.blob();
    }
    const filename=modelName+(format==='fbx'?'-fbx.zip':`.${format}`),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status(`Сохранено: ${filename}.`);
  }catch(err){status(`Ошибка экспорта: ${err.message}`);}finally{readableTextures.forEach(texture=>texture.dispose());original.forEach((value,mat)=>{mat.wireframe=value;});lock(false);}
});
