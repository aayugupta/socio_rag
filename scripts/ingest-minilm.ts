#!/usr/bin/env tsx
/**
 * Local MiniLM Ingestion — scripts/ingest-minilm.ts
 * Uses @xenova/transformers Xenova/all-MiniLM-L6-v2 (384 dims, free, offline) instead of OpenAI.
 * Stores at ./chroma_db/local_minilm_store.json (separate from OpenAI local_store.json).
 * ADR-2 WARNING: MiniLM vectors are NOT comparable with OpenAI vectors — use separate collection name.
 *
 * Usage:
 *   npx tsx scripts/ingest-minilm.ts --dry-run
 *   npx tsx scripts/ingest-minilm.ts
 *   npx tsx scripts/ingest-minilm.ts --batch-size 32
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120;
const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const LOCAL_DIMS = 384;
const DEFAULT_BATCH = 32;
const LOCAL_DIR = path.resolve(process.cwd(), "chroma_db");
const LOCAL_JSON = path.join(LOCAL_DIR, "local_minilm_store.json");
const MANIFEST = path.join(LOCAL_DIR, "local_minilm_manifest.json");
const TEST_QUERY = "What does Nishant Sir say about Weber's bureaucracy?";
const DEFAULT_COLLECTION = "sociology-minilm";
const DEFAULT_PDF_REL = path.join("data", "Sociology.pdf");
const FALLBACK_PDF_WIN = `C:\\Users\\aarad\\Downloads\\_Handouts_Sociology2024byNishantSir_LevelupIAS_KING_R_QUEEN_P.PDF`;

const KNOWN_HEADINGS = ["Weber","Marx","Durkheim","Comte","Spencer","Parsons","Merton","Mead","Goffman","Bourdieu","Foucault","Functionalism","Conflict Theory","Symbolic Interactionism","Structural Functionalism","Social Stratification","Bureaucracy","Religion","Education","Family","Kinship","Social Change","Auguste Comte","Karl Marx","Max Weber","Emile Durkheim","Talcott Parsons","Robert Merton"];

function log(msg:string){ const ts=new Date().toISOString().slice(11,23); console.log(`[${ts}] ${msg}`)}
function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms))}
function hashId(text:string, page:any, idx:number, source:string){ return createHash("sha256").update(`${source}::${page}::${idx}::${text.slice(0,120)}`).digest("hex").slice(0,16) }

function parseArgs(argv:string[]){
  const a:any={dryRun:false,help:false, pdfPath:null, collection:null, batchSize:DEFAULT_BATCH, skipVerify:false};
  for(let i=0;i<argv.length;i++){
    const v=argv[i];
    if(v==="--dry-run"||v==="-d") a.dryRun=true;
    else if(v==="--help"||v==="-h") a.help=true;
    else if(v==="--pdf" && argv[i+1]) a.pdfPath=argv[++i];
    else if(v.startsWith("--pdf=")) a.pdfPath=v.split("=")[1];
    else if(v==="--collection" && argv[i+1]) a.collection=argv[++i];
    else if(v==="--batch-size" && argv[i+1]) a.batchSize=parseInt(argv[++i],10);
    else if(v==="--skip-verify") a.skipVerify=true;
  }
  if(process.argv.includes("--dry-run")) a.dryRun=true;
  return a;
}
function printHelp(){
  console.log(`MiniLM Local Ingestion (free, offline)
Model: ${LOCAL_MODEL} (${LOCAL_DIMS} dims)
Usage: npx tsx scripts/ingest-minilm.ts [--dry-run] [--pdf <path>] [--collection <name>] [--batch-size <n>]`);
}
function resolvePdf(cliPath:string|null):string{
  if(cliPath && fs.existsSync(cliPath)) return path.resolve(cliPath);
  const rel=path.resolve(process.cwd(), DEFAULT_PDF_REL);
  if(fs.existsSync(rel)) return rel;
  if(fs.existsSync(FALLBACK_PDF_WIN)) return FALLBACK_PDF_WIN;
  throw new Error(`PDF not found: tried ${rel} and ${FALLBACK_PDF_WIN}. Place PDF at data/Sociology.pdf`);
}
interface PageText{page:number;text:string}
interface Chunk{ text:string; metadata:{page:number; section:string; chunkIndex:number; source:string}}

async function extractPages(pdfPath:string):Promise<PageText[]>{
  const buf=fs.readFileSync(pdfPath);
  log(`Read ${buf.length} bytes, extracting...`);
  let pages:PageText[]=[];
  try{
    const { PDFParse } = await import("pdf-parse");
    // @ts-ignore
    const parser=new PDFParse({data:buf});
    const res=await parser.getText();
    // pdf-parse v2: res.pages? Try generic
    if((res as any).pages){
      pages=(res as any).pages.map((p:any,i:number)=>({page:i+1, text: String(p.text||p).trim()}));
    } else if((res as any).text){
      const full=(res as any).text as string;
      // fallback: split roughly by page marker? Use single page
      pages=[{page:1, text:full}];
      log(`pdf-parse v2 returned single text block (${full.length} chars) — using as 1 page`);
    }
    await parser.destroy?.();
    // If still single and we expected 315, try unpdf fallback
    if(pages.length===1 && pages[0].text.length>50000){
      log(`Single page large, trying unpdf for per-page split...`);
      try{
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf=await getDocumentProxy(new Uint8Array(buf));
        const { text, totalPages }=await extractText(pdf, {mergePages:false}) as any;
        if(Array.isArray(text) && text.length>1){
          pages=text.map((t:string,i:number)=>({page:i+1, text:t.trim()}));
          log(`unpdf: ${pages.length} pages`);
        }
      }catch(e){ log(`unpdf fallback failed: ${e instanceof Error?e.message:String(e)}`)}
    }
  }catch(e){
    log(`pdf-parse failed: ${e instanceof Error?e.message:String(e)}, trying unpdf...`);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf=await getDocumentProxy(new Uint8Array(buf));
    const { text }=await extractText(pdf, {mergePages:false}) as any;
    if(Array.isArray(text)) pages=text.map((t:string,i:number)=>({page:i+1, text:t.trim()}));
    else pages=[{page:1, text:String(text)}];
  }
  pages=pages.filter(p=>p.text.length>20);
  log(`Extracted ${pages.length} pages, total chars ${pages.reduce((a,p)=>a+p.text.length,0)}`);
  return pages;
}

async function createChunks(pages:PageText[], source:string):Promise<Chunk[]>{
  log(`Chunking ${pages.length} pages with RecursiveCharacterTextSplitter ${CHUNK_SIZE}/${CHUNK_OVERLAP}`);
  let Splitter:any=null;
  try{ const m=await import("@langchain/textsplitters"); Splitter=m.RecursiveCharacterTextSplitter }catch{ const m=await import("langchain/text_splitter" as any); Splitter=(m as any).RecursiveCharacterTextSplitter }
  const splitter=new Splitter({chunkSize:CHUNK_SIZE, chunkOverlap:CHUNK_OVERLAP, separators:["\n\n","\n",". "," ",""]});
  const chunks:Chunk[]=[];
  for(const pg of pages){
    let section="General";
    for(const h of KNOWN_HEADINGS){ if(pg.text.includes(h)){ section=h; break; }}
    const docs=await splitter.createDocuments([pg.text], [{page:pg.page, section, source}]);
    docs.forEach((d:any, idx:number)=>{
      const txt=String(d.pageContent||d.text||"").trim();
      if(!txt) return;
      const meta=d.metadata||{};
      chunks.push({ text:txt, metadata:{page: meta.page ?? pg.page, section: meta.section ?? section, chunkIndex: chunks.length, source}});
    });
  }
  log(`Created ${chunks.length} chunks avg ${Math.round(chunks.reduce((a,c)=>a+c.text.length,0)/Math.max(1,chunks.length))} chars`);
  if(chunks[0]) log(`Sample[0] page=${chunks[0].metadata.page} section=${chunks[0].metadata.section} len=${chunks[0].text.length} preview="${chunks[0].text.slice(0,120).replace(/\s+/g,' ')}..."`);
  return chunks;
}

async function getLocalPipeline(){
  const mod=await import("@xenova/transformers");
  // @ts-ignore
  const { pipeline, env } = mod;
  // @ts-ignore
  if(env){ env.allowRemoteModels=true; env.allowLocalModels=true; }
  log(`Loading ${LOCAL_MODEL} (first run downloads ~80MB, cached after)...`);
  const pipe=await (pipeline as any)("feature-extraction", LOCAL_MODEL, {quantized:true});
  log(`Model loaded ✓`);
  return pipe;
}

async function embedChunksLocal(chunks:Chunk[], batchSize:number, dryRun:boolean, pipe:any):Promise<number[][]|null>{
  if(dryRun){ log(`[dry-run] Would embed ${chunks.length} chunks in ${Math.ceil(chunks.length/batchSize)} batches`); return null; }
  log(`Embedding ${chunks.length} chunks via ${LOCAL_MODEL} batches=${batchSize} (offline, no API)`);
  const all:number[][]=[];
  const total=Math.ceil(chunks.length/batchSize);
  const t0=Date.now();
  for(let b=0;b<total;b++){
    const s=b*batchSize, e=Math.min(s+batchSize, chunks.length);
    const slice=chunks.slice(s,e);
    log(`  Batch ${b+1}/${total} ${s}-${e-1} (${slice.length})...`);
    const bt0=Date.now();
    for(const c of slice){
      const out=await pipe(c.text, {pooling:"mean", normalize:true});
      const arr=Array.from(out.data as Float32Array) as number[];
      all.push(arr);
    }
    log(`    ✓ batch ${b+1} in ${((Date.now()-bt0)/1000).toFixed(1)}s`);
    if(b<total-1) await sleep(10);
  }
  log(`All embeddings done ${all.length} vectors ${((Date.now()-t0)/1000).toFixed(1)}s dims=${all[0]?.length??0}`);
  return all;
}

function cosine(a:number[], b:number[]){ let dot=0, na=0, nb=0; const n=Math.min(a.length,b.length); for(let i=0;i<n;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return dot/(Math.sqrt(na)*Math.sqrt(nb)||1); }

async function main(){
  const cli=parseArgs(process.argv.slice(2));
  if(cli.help){ printHelp(); process.exit(0)}
  console.warn("=".repeat(80));
  console.warn(`MiniLM local ingest: ${LOCAL_MODEL} (${LOCAL_DIMS} dims) — FREE, offline, no OpenAI needed`);
  console.warn("Vectors NOT compatible with OpenAI 1536 dims — keep collection separate (sociology-minilm)");
  console.warn("=".repeat(80));
  const pdfPath=resolvePdf(cli.pdfPath);
  const source=path.basename(pdfPath);
  const collection=cli.collection ?? process.env.CHROMA_COLLECTION_MINILM ?? DEFAULT_COLLECTION;
  const batch=cli.batchSize>0&&cli.batchSize<=200?cli.batchSize:DEFAULT_BATCH;
  log(`pdf="${pdfPath}" collection="${collection}" batch=${batch} dryRun=${cli.dryRun}`);
  if(!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR,{recursive:true});
  // extract
  const pages=await extractPages(pdfPath);
  const chunks=await createChunks(pages, source);
  if(cli.dryRun){
    const tot=chunks.reduce((a,c)=>a+c.text.length,0);
    log(`[dry-run] ${chunks.length} chunks, ${tot} chars, would embed via MiniLM locally (0$)`);
    process.exit(0);
  }
  const pipe=await getLocalPipeline();
  const embeddings=await embedChunksLocal(chunks, batch, false, pipe);
  if(!embeddings) throw new Error("no embeddings");
  // persist JSON
  const store={collection, embedding_model:LOCAL_MODEL, embedding_dims:LOCAL_DIMS, created_at:new Date().toISOString(), count:chunks.length, chunks: chunks.map((c,i)=>({id:hashId(c.text,c.metadata.page,c.metadata.chunkIndex,source), text:c.text, embedding:embeddings[i], metadata:c.metadata}))};
  fs.writeFileSync(LOCAL_JSON, JSON.stringify(store,null,2));
  log(`Wrote ${LOCAL_JSON} ${(fs.statSync(LOCAL_JSON).size/1024/1024).toFixed(2)} MB`);
  fs.writeFileSync(MANIFEST, JSON.stringify({collection, embedding_model:LOCAL_MODEL, dims:LOCAL_DIMS, count:chunks.length, created_at:store.created_at, source},null,2));
  log(`Wrote ${MANIFEST}`);
  // verify
  if(!cli.skipVerify){
    log(`Verifying top-5 for "${TEST_QUERY}" (brute-force cosine)...`);
    const qOut=await pipe(TEST_QUERY, {pooling:"mean", normalize:true});
    const qEmb=Array.from(qOut.data as Float32Array) as number[];
    const scored=chunks.map((c,i)=>({c, score:cosine(qEmb, embeddings[i])})).sort((a,b)=>b.score-a.score).slice(0,5);
    console.log(`\nTop-5 for "${TEST_QUERY}"`);
    scored.forEach((s,i)=>{ console.log(` #${i+1} cosine=${s.score.toFixed(4)} page=${s.c.metadata.page} section=${s.c.metadata.section}`); console.log(`    "${s.c.text.slice(0,200).replace(/\s+/g,' ')}..."`)});
    const hasWeber=scored.some(s=>/weber|bureaucracy/i.test(s.c.text));
    log(hasWeber ? "✅ Contains Weber/bureaucracy" : "⚠ Top-k lacks Weber");
  }
  log(`✅ Done ${chunks.length} chunks → ${LOCAL_DIR} in ${LOCAL_DIMS} dims`);
}
main().catch(e=>{ console.error(e); process.exit(1)});
