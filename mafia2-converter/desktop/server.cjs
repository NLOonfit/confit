const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);

async function startServer(root,getBlender){
  let port;
  const server=http.createServer(async(req,res)=>{
    const error=(code,message)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:message}));};
    try{
      if(req.method==='POST'&&/^\/api\/export\/(blend|fbx)$/.test(req.url)){
        if(req.headers['x-m2-request']!=='export'||req.headers.origin!==`http://127.0.0.1:${port}`)return error(403,'Недопустимый запрос.');
        const length=Number(req.headers['content-length']);
        if(!Number.isSafeInteger(length)||length<12||length>256*1024*1024)return error(413,'Максимальный размер модели: 256 МБ.');
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>length)return error(413,'Слишком большой файл.');chunks.push(chunk);}
        const data=Buffer.concat(chunks);
        if(bytes!==length||data.subarray(0,4).toString()!=='glTF')return error(400,'Ожидался GLB.');
        const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mafia2-export-'));
        try{
          await fs.writeFile(path.join(temp,'input.glb'),data);
          const format=req.url.split('/').pop();
          await run(getBlender(),['--background','--factory-startup','--threads','2','--python-exit-code','1','--python',path.join(root,'blender_export.py'),'--',path.join(temp,'input.glb'),temp,format],{timeout:180000,maxBuffer:8*1024*1024,windowsHide:true});
          const output=await fs.readFile(path.join(temp,format==='fbx'?'model-fbx.zip':'model.blend'));
          res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':output.length});res.end(output);
        }catch(err){
          console.error('Blender export:',err.stderr||err.message);
          error(422,err.code==='ENOENT'?'Blender не найден. Нажмите «Выбрать Blender» и укажите blender.exe.':'Ошибка Blender. Проверьте выбранную программу и журнал приложения.');
        }finally{await fs.rm(temp,{recursive:true,force:true});}
        return;
      }
      if(!['GET','HEAD'].includes(req.method))return error(405,'Метод не поддерживается.');
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const base=path.join(root,'dist'),file=path.resolve(base,`.${pathname==='/'?'/index.html':pathname}`);
      if(!file.startsWith(base+path.sep))return error(403,'Недопустимый путь.');
      const data=await fs.readFile(file);
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch(err){error(err.code==='ENOENT'?404:500,'Ошибка локального сервиса.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  port=server.address().port;
  return{server,url:`http://127.0.0.1:${port}`};
}
module.exports={startServer};
