// Independent reader for the PC SDS v19 layout verified against albert.sds.
class Reader {
  constructor(bytes){this.bytes=bytes;this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);this.at=0;}
  take(n){if(!Number.isSafeInteger(n)||n<0||this.at+n>this.bytes.length)throw Error('Повреждён SDS: выход за границы ресурса.');const start=this.at;this.at+=n;return this.bytes.subarray(start,this.at);}
  skip(n){this.take(n);}
  read(method,n){const start=this.at;this.take(n);return this.view[method](start,true);}
  u8(){return this.read('getUint8',1);}
  u16(){return this.read('getUint16',2);}
  u32(){return this.read('getUint32',4);}
  f32(){return this.read('getFloat32',4);}
  hash(){return this.read('getBigUint64',8).toString(16).padStart(16,'0');}
  namedHash(){const hash=this.hash(),name=new TextDecoder().decode(this.take(this.u16()));return{hash,name};}
}
const fail=message=>{throw Error(message);};
const count=(n,limit=1000000)=>n<=limit?n:fail('Слишком большое число элементов SDS.');

async function inflate(bytes,limit){
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>limit){await reader.cancel();fail('Некорректный размер распакованного блока.');}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  const result=new Uint8Array(length);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}return result;
}

export async function unpackSds(buffer){
  const bytes=new Uint8Array(buffer),r=new Reader(bytes);
  if(bytes.length>256*1024*1024)fail('Максимальный размер SDS: 256 МБ.');
  if(r.u32()!==0x00534453)fail('Это не SDS. Зашифрованные контейнеры пока не поддерживаются.');
  if(r.u32()!==19||r.u32()!==0x4350)fail('Поддерживается только PC SDS v19 оригинальной Mafia II.');
  r.skip(4);const typeOffset=r.u32(),blockOffset=r.u32(),xmlOffset=r.u32();
  r.at=64;const resourceCount=count(r.u32(),10000);
  r.at=typeOffset;const types=new Map(),typeCount=count(r.u32(),1024);
  for(let i=0;i<typeCount;i++){const id=r.u32(),name=new TextDecoder().decode(r.take(count(r.u32(),1024)));r.skip(4);types.set(id,name);}
  r.at=blockOffset;
  if(r.u32()!==0x6c7a4555)fail('Неизвестный формат блоков SDS.');
  const alignment=r.u32();if(alignment<1||alignment>1024*1024||r.u8()!==4)fail('Неподдерживаемое сжатие SDS.');
  const chunks=[];let total=0;
  while(true){
    const size=r.u32(),compressed=r.u8();if(!size)break;
    if(compressed){
      const start=r.at,expected=r.u32(),header=r.u32();r.u16();const chunkCount=count(r.u16(),8);r.skip(4);const sizes=Array.from({length:8},()=>r.u16());
      if(header!==32||size!==32+sizes.reduce((a,b)=>a+b,0))fail('Неподдерживаемый или повреждённый блок SDS.');
      if(!chunkCount||expected>alignment*chunkCount)fail('Некорректный размер блока SDS.');
      let produced=0;
      for(let i=0;i<chunkCount;i++){const output=await inflate(r.take(sizes[i]),Math.min(alignment,expected-produced));produced+=output.length;total+=output.length;if(total>512*1024*1024)fail('Распакованный SDS превышает 512 МБ.');chunks.push(output);}
      if(produced!==expected||r.at!==start+size)fail('Некорректная длина блока SDS.');
    }else{const output=r.take(size);total+=output.length;if(total>512*1024*1024)fail('Распакованный SDS превышает 512 МБ.');chunks.push(output);}
  }
  const expanded=new Uint8Array(total);let at=0;for(const chunk of chunks){expanded.set(chunk,at);at+=chunk.length;}
  const content=new Reader(expanded),entries=[];
  for(let i=0;i<resourceCount;i++){const id=content.u32(),size=content.u32(),version=content.u16();content.skip(20);if(size<30||!types.has(id))fail('Некорректный заголовок ресурса SDS.');entries.push({type:types.get(id),version,bytes:content.take(size-30),name:''});}
  if(content.at!==total)fail('Число ресурсов SDS не соответствует содержимому.');
  if(xmlOffset){
    if(xmlOffset>=bytes.length)fail('Некорректное смещение XML SDS.');
    const document=new DOMParser().parseFromString(new TextDecoder().decode(bytes.subarray(xmlOffset)),'application/xml'),info=[...document.querySelectorAll('ResourceInfo')];
    entries.forEach((entry,i)=>{if(info[i]?.querySelector('TypeName')?.textContent===entry.type)entry.name=info[i].querySelector('SourceDataDescription')?.textContent?.trim()||'';});
  }
  return entries;
}

function pools(entries,type){
  const buffers=new Map();
  for(const entry of entries.filter(e=>e.type===type)){
    if(entry.version!==2)fail('Неподдерживаемая версия пула буферов.');
    const r=new Reader(entry.bytes);r.u8();const n=count(r.u32(),128);r.u32();
    for(let i=0;i<n;i++){const hash=r.hash(),format=type==='IndexBufferPool'?r.u32():null;buffers.set(hash,{format,bytes:r.take(r.u32())});}
    if(r.at!==entry.bytes.length)fail('Неподдерживаемая структура пула буферов SDS.');
  }
  return buffers;
}
function skipCollision(r){
  r.skip(8);const flags=r.u32(),quantized=r.u8();
  if(quantized){if((flags&3)!==3||(flags&4))fail('Неподдерживаемое дерево коллизий SDS.');r.skip(24);r.skip(count(r.u32())*20);}
  const leaves=count(r.u32());if(r.u8())r.skip(leaves*4);const primitives=count(r.u32());if(r.u8())r.skip(primitives*4);
}
function skipSplits(r){
  const type=r.u32();if(!type)return;if(![1,12].includes(type))fail('Неподдерживаемые группы геометрии SDS.');
  if(type===12){r.skip(20);if(r.u32()!==1)fail('Неподдерживаемое число групп SDS.');}
  r.u8();r.u32();const burstSize=r.u32(),splitSize=r.u32(),bursts=count(r.u32()),splits=count(r.u32());r.hash();
  if(burstSize!==20||splitSize!==12)fail('Неподдерживаемая разметка групп SDS.');r.skip(bursts*burstSize+splits*splitSize);
}
function half(bits){const sign=bits&0x8000?-1:1,exp=(bits>>10)&31,fraction=bits&1023;return exp===0?sign*2**-14*fraction/1024:exp===31?(fraction?NaN:sign*Infinity):sign*2**(exp-15)*(1+fraction/1024);}
function vertices(bytes,lod,offset,scale){
  const order=[[1,8],[4,4],[64,8],[128,4],[131072,4],[1048576,4],[256,4],[512,4],[1024,4],[2048,4],[32768,4],[262144,12],[16,0]],known=order.reduce((mask,[flag])=>mask|flag,0);
  if(!(lod.flags&1)||(lod.flags&~known))fail('Неподдерживаемый формат вершин SDS.');
  let stride=0;const offsets=new Map();for(const[flag,size]of order)if(lod.flags&flag){offsets.set(flag,stride);stride+=size;}
  if(bytes.length!==lod.vertices*stride)fail('Длина буфера вершин SDS не соответствует декларации.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),positions=new Float32Array(lod.vertices*3),normals=new Float32Array(lod.vertices*3),uvs=new Float32Array(lod.vertices*2);
  for(let i=0;i<lod.vertices;i++){
    const p=i*stride;positions[i*3]=view.getUint16(p,true)*scale+offset[0];positions[i*3+1]=view.getUint16(p+2,true)*scale+offset[1];positions[i*3+2]=(view.getUint16(p+4,true)&0x7fff)*scale+offset[2];
    if(offsets.has(4))for(let axis=0;axis<3;axis++)normals[i*3+axis]=(view.getUint8(p+offsets.get(4)+axis)-127)/127;
    if(offsets.has(256))for(let axis=0;axis<2;axis++)uvs[i*2+axis]=half(view.getUint16(p+offsets.get(256)+axis*2,true));
  }
  if(![positions,normals,uvs].every(values=>values.every(Number.isFinite)))fail('Некорректные координаты SDS.');
  return{positions,normals:offsets.has(4)?normals:null,uvs:offsets.has(256)?uvs:null};
}

export function readSdsModel(entries){
  const ib=pools(entries,'IndexBufferPool'),vb=pools(entries,'VertexBufferPool'),frames=entries.filter(e=>e.type==='FrameResource');
  if(frames.length!==1||frames[0].version!==28)fail('Поддерживается один FrameResource v28 в SDS.');
  const r=new Reader(frames[0].bytes),scene=r.u8(),counts=Array.from({length:7},()=>count(r.u32(),10000));
  if(scene||counts[0]||counts[1]!==1||counts[2]!==1)fail('Поддерживаются отдельные модели с одной геометрией; сцены пока не поддерживаются.');
  const lodCount=count(r.u8(),8);r.u16();const offset=[r.f32(),r.f32(),r.f32()],scale=r.f32(),lods=[];
  if(!lodCount||!Number.isFinite(scale)||scale<=0)fail('Некорректное описание геометрии SDS.');
  for(let i=0;i<lodCount;i++){
    const distance=r.f32(),index=r.namedHash(),flags=r.u32(),vertex=r.namedHash(),numVertices=count(r.u32());r.u32();if(r.u32())skipCollision(r);skipSplits(r);if(r.u32()!==0)fail('Неподдерживаемый конец блока LOD.');
    lods.push({name:vertex.name.replace(/\.VB\d+$/,''),flags,vertices:numVertices,vertexHash:vertex.hash,indexHash:index.hash,distance});
  }
  const materialLods=count(r.u8(),8),materialCounts=Array.from({length:materialLods},()=>count(r.u32(),1024));r.skip(24);
  if(materialLods!==lodCount||materialCounts.some(n=>!n))fail('Количество материалов LOD не соответствует геометрии.');
  for(let i=0;i<materialLods;i++){
    const groups=[];for(let j=0;j<materialCounts[i];j++){const faces=count(r.u32()),start=r.u32(),material=r.hash();r.u32();groups.push({start,count:faces*3,material});}lods[i].groups=groups;
  }
  for(const lod of lods){
    const vertex=vb.get(lod.vertexHash),index=ib.get(lod.indexHash);if(!vertex||!index)fail('Не найден буфер геометрии SDS.');
    if(![1,2].includes(index.format))fail('Неподдерживаемый формат индексов SDS.');
    const width=index.format===1?2:4,view=new DataView(index.bytes.buffer,index.bytes.byteOffset,index.bytes.byteLength);if(index.bytes.length%width)fail('Некорректная длина индексов SDS.');
    lod.indices=new Uint32Array(index.bytes.length/width);
    for(let i=0;i<lod.indices.length;i++){const value=width===2?view.getUint16(i*width,true):view.getUint32(i*width,true);if(value>=lod.vertices)fail('Индекс SDS выходит за пределы меша.');lod.indices[i]=value;}
    let end=0;for(const group of lod.groups){if(group.start!==end)fail('Неподдерживаемое перекрытие или разрыв групп SDS.');end+=group.count;}
    if(lod.indices.length%3||end!==lod.indices.length)fail('Некорректные группы треугольников SDS.');
    Object.assign(lod,vertices(vertex.bytes,lod,offset,scale));
  }
  const textures=new Map();
  for(const entry of entries.filter(e=>['Texture','Mipmap'].includes(e.type))){
    const r=new Reader(entry.bytes),hash=r.hash();r.u8();if(entry.type==='Texture'&&entry.version===2)r.u8();const data=r.take(entry.bytes.length-r.at),header=new Reader(data);
    if(header.u32()!==0x20534444)fail('В SDS найдена неподдерживаемая текстура.');header.skip(12);const width=header.u32();
    const name=entry.name&&entry.name!=='not available'?entry.name:`${hash}.dds`;
    if(!textures.has(hash)||width>textures.get(hash).width)textures.set(hash,{hash,name,width,bytes:data});
  }
  return{lods,textures:[...textures.values()],resourceCount:entries.length,hasSkeleton:counts[4]>0};
}
