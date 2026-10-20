import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));

// The key lives outside both the database and the explicit public upload list.
// Never print its value; the owner can copy this private file into a CF Secret.
export async function ensureLocalAccountSecret(root=ROOT){
  const directory=path.join(root,'.local');
  const filename=path.join(directory,'AUTH_SECRET.txt');
  await mkdir(directory,{recursive:true});
  try{
    const saved=(await readFile(filename,'utf8')).trim();
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(saved))throw new Error('Invalid local account secret');
    return saved;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const generated=randomBytes(32).toString('base64url');
  try{await writeFile(filename,generated+'\n',{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')return ensureLocalAccountSecret(root);throw error;}
  return generated;
}

async function main(){
  await ensureLocalAccountSecret();
  if(!process.argv.includes('--secret-only')){
    const {createLocalDatabase}=await import('./local-db.mjs');
    const db=createLocalDatabase({filename:path.join(ROOT,'.local','gil.sqlite')});
    db.close();
  }
  console.log('계정 DB 준비 완료. 비밀값은 .local/AUTH_SECRET.txt에 보관했어요. 파일이나 DB를 업로드하지 마세요.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(()=>{console.error('계정 DB 설정을 준비하지 못했어요. 폴더의 쓰기 권한을 확인해 주세요.');process.exitCode=1;});
}
