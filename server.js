const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const multer=require('multer');
const XLSX=require('xlsx');
const OpenAI=require('openai');
const {Pool}=require('pg');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const pgSession=require('connect-pg-simple')(session);

const app=express();
const PORT=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'MISSING');
const upload=multer({dest:'/tmp/eiyaku-uploads',limits:{fileSize:5*1024*1024}});
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use(rateLimit({windowMs:60*1000,max:120,standardHeaders:true,legacyHeaders:false}));
app.set('trust proxy',1);
app.use(session({secret:process.env.SESSION_SECRET||'change-me',resave:false,saveUninitialized:false,store:new pgSession({pool,tableName:'user_sessions',createTableIfMissing:true}),cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:12*60*60*1000}}));
app.get('/teacher', (req,res)=>res.sendFile('/app/teacher.html'));
app.use(express.static('/app'));

async function q(text,params=[]){const r=await pool.query(text,params);return r.rows}
async function one(text,params=[]){const r=await pool.query(text,params);return r.rows[0]}
function auth(req,res,next){if(!req.session.user)return res.status(401).json({error:'ログインしてください'});next()}
function teacher(req,res,next){if(!req.session.user||req.session.user.role!=='teacher')return res.status(403).json({error:'教師権限が必要です'});next()}
function normUser(u){return {id:u.id,name:u.name,role:u.role}}

async function init(){
 for(let i=0;i<30;i++){try{await q('SELECT 1');break}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,2000));}}
 await q(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('teacher','student')),password_hash TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now());`);
 await q(`CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,english TEXT NOT NULL,model TEXT NOT NULL,points NUMERIC DEFAULT 10,key1 TEXT,key2 TEXT,key3 TEXT,difficulty TEXT,category TEXT,updated_at TIMESTAMPTZ DEFAULT now());`);
 await q(`CREATE TABLE IF NOT EXISTS progress(user_id TEXT REFERENCES users(id) ON DELETE CASCADE,question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,attempts INT NOT NULL DEFAULT 0,correct INT NOT NULL DEFAULT 0,streak INT NOT NULL DEFAULT 0,last_score NUMERIC,last_status TEXT,last_answer TEXT,last_feedback TEXT,last_seen TIMESTAMPTZ,PRIMARY KEY(user_id,question_id));`);
 await q(`CREATE TABLE IF NOT EXISTS attempts(id BIGSERIAL PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,student_answer TEXT,score NUMERIC,status TEXT,feedback TEXT,hint TEXT,created_at TIMESTAMPTZ DEFAULT now());`);
 const t=await one(`SELECT id FROM users WHERE role='teacher' LIMIT 1`);
 if(!t){const pw=process.env.INIT_TEACHER_PASSWORD||'change-this-password';await q(`INSERT INTO users(id,name,role,password_hash) VALUES($1,$2,'teacher',$3)`,['teacher','先生',bcrypt.hashSync(pw,12)]);}
}

app.get('/api/health',async(req,res)=>{try{await q('SELECT 1');res.json({ok:true})}catch(e){res.status(503).json({ok:false})}});
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));
app.post('/api/login',async(req,res)=>{try{const u=await one(`SELECT * FROM users WHERE id=$1`,[req.body?.id||'']);if(!u||!bcrypt.compareSync(req.body?.password||'',u.password_hash))return res.status(401).json({error:'IDまたはパスワードが違います'});req.session.user=normUser(u);res.json({user:req.session.user})}catch(e){res.status(500).json({error:'ログイン処理に失敗しました'})}});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/questions',auth,async(req,res)=>{res.json(await q(`SELECT id,english,model,points,key1,key2,key3,difficulty,category FROM questions ORDER BY id`))});
app.get('/api/progress',auth,async(req,res)=>{const rows=await q(`SELECT question_id AS id,attempts,correct,streak,last_score,last_status,last_feedback,last_seen FROM progress WHERE user_id=$1`,[req.session.user.id]);const out={};for(const r of rows)out[r.id]=r;res.json(out)});
app.post('/api/progress',auth,async(req,res)=>{const {questionId,ok}=req.body||{};if(!questionId)return res.status(400).json({error:'questionIdが必要です'});const p=await one(`SELECT * FROM progress WHERE user_id=$1 AND question_id=$2`,[req.session.user.id,questionId]);const attempts=(p?.attempts||0)+1,correct=(p?.correct||0)+(ok?1:0),streak=ok?(p?.streak||0)+1:0;const r=await one(`INSERT INTO progress(user_id,question_id,attempts,correct,streak,last_seen) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(user_id,question_id) DO UPDATE SET attempts=EXCLUDED.attempts,correct=EXCLUDED.correct,streak=EXCLUDED.streak,last_seen=now() RETURNING *`,[req.session.user.id,questionId,attempts,correct,streak]);res.json(r)});

app.post('/api/grade',auth,async(req,res)=>{
 try{
  const {questionId,english,model,student}=req.body||{};if(!questionId||!english||!model||!student)return res.status(400).json({error:'必要な情報が不足しています'});
  if(!openai)return res.status(503).json({error:'AI採点用APIキーが未設定です'});
  const response=await openai.responses.create({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',input:[{role:'system',content:[{type:'input_text',text:`あなたは高校生向け英文和訳の採点者です。模範解答との意味の一致を重視してください。自然な日本語への言い換えは減点しすぎないでください。主語・述語・目的語、否定、比較、条件、因果、時制、重要語句など意味の核を評価します。出力はJSONのみ。scoreは0-10の整数、statusは正解/部分正解/不正解のいずれか。explanationは短く具体的に、hintは答えを丸ごと出さず再挑戦できるヒントにしてください。`}]},{role:'user',content:[{type:'input_text',text:`英文:\n${english}\n\n模範解答:\n${model}\n\n生徒訳:\n${student}`}]}],text:{format:{type:'json_schema',name:'grading',schema:{type:'object',additionalProperties:false,properties:{score:{type:'integer'},status:{type:'string',enum:['正解','部分正解','不正解']},explanation:{type:'string'},hint:{type:'string'}},required:['score','status','explanation','hint']}}}});
  const data=JSON.parse(response.output_text);
  await q(`INSERT INTO attempts(user_id,question_id,student_answer,score,status,feedback,hint) VALUES($1,$2,$3,$4,$5,$6,$7)`,[req.session.user.id,questionId,student,data.score,data.status,data.explanation,data.hint]);
  const ok=data.score>=8;const p=await one(`SELECT * FROM progress WHERE user_id=$1 AND question_id=$2`,[req.session.user.id,questionId]);const attempts=(p?.attempts||0)+1,correct=(p?.correct||0)+(ok?1:0),streak=ok?(p?.streak||0)+1:0;
  await q(`INSERT INTO progress(user_id,question_id,attempts,correct,streak,last_score,last_status,last_answer,last_feedback,last_seen) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(user_id,question_id) DO UPDATE SET attempts=EXCLUDED.attempts,correct=EXCLUDED.correct,streak=EXCLUDED.streak,last_score=EXCLUDED.last_score,last_status=EXCLUDED.last_status,last_answer=EXCLUDED.last_answer,last_feedback=EXCLUDED.last_feedback,last_seen=now()`,[req.session.user.id,questionId,attempts,correct,streak,data.score,data.status,student,data.explanation]);
  res.json(data);
 }catch(e){console.error(e);res.status(500).json({error:'AI採点に失敗しました'})}
});

app.get('/api/teacher/students',teacher,async(req,res)=>{const rows=await q(`SELECT u.id,u.name,COUNT(q.id)::int AS total,COUNT(p.question_id) FILTER(WHERE p.streak>=3)::int AS mastered,COALESCE(SUM(p.attempts),0)::int AS attempts,COALESCE(SUM(p.correct),0)::int AS correct,MAX(p.last_seen) AS last_seen FROM users u CROSS JOIN questions q LEFT JOIN progress p ON p.user_id=u.id AND p.question_id=q.id WHERE u.role='student' GROUP BY u.id,u.name ORDER BY u.id`);res.json(rows)});
app.post('/api/teacher/students',teacher,async(req,res)=>{const {id,name,password}=req.body||{};if(!id||!name||!password)return res.status(400).json({error:'ID・氏名・パスワードは必須です'});try{const r=await one(`INSERT INTO users(id,name,role,password_hash) VALUES($1,$2,'student',$3) RETURNING id,name`,[id,name,bcrypt.hashSync(password,12)]);res.json(r)}catch(e){res.status(400).json({error:'そのIDは既に使われています'})}});
app.post('/api/teacher/import',teacher,upload.single('file'),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Excelファイルがありません'});const wb=XLSX.readFile(req.file.path);const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});const clean=rows.filter(r=>String(r['英文']||'').trim()&&String(r['模範解答']||'').trim());if(!clean.length)return res.status(400).json({error:'英文と模範解答のある行が見つかりません'});const client=await pool.connect();try{await client.query('BEGIN');await client.query('DELETE FROM questions');for(let i=0;i<clean.length;i++){const r=clean[i],id=String(r['問題ID']||`Q${i+1}`);await client.query(`INSERT INTO questions(id,english,model,points,key1,key2,key3,difficulty,category) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,String(r['英文']),String(r['模範解答']),Number(r['配点']||10),String(r['重要ポイント1']||''),String(r['重要ポイント2']||''),String(r['重要ポイント3']||''),String(r['難易度']||''),String(r['カテゴリ']||'')]);}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}res.json({count:clean.length})}catch(e){console.error(e);res.status(500).json({error:'教材の取り込みに失敗しました'})}});
app.get('/api/teacher/attempts',teacher,async(req,res)=>{const rows=await q(`SELECT a.created_at,u.id AS student_id,u.name,q.id AS question_id,a.score,a.status,a.student_answer,a.feedback,a.hint FROM attempts a JOIN users u ON u.id=a.user_id JOIN questions q ON q.id=a.question_id ORDER BY a.created_at DESC LIMIT 300`);res.json(rows)});
app.get('/api/teacher/question-mastery',teacher,async(req,res)=>{const rows=await q(`SELECT q.id,q.english,u.id AS student_id,u.name,p.attempts,p.correct,p.streak,p.last_score,p.last_status,p.last_seen FROM questions q CROSS JOIN users u LEFT JOIN progress p ON p.question_id=q.id AND p.user_id=u.id WHERE u.role='student' ORDER BY u.id,q.id`);res.json(rows)});

init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
